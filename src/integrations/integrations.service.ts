import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt, encrypt, isEncryptionConfigured } from '../common/utils/crypto.util';
import { DEFAULT_AI_MODEL } from '../ai/ai-llm';
import {
  AnthropicConfig,
  AnthropicStored,
  CloudinaryConfig,
  CloudinaryStored,
  IntegrationName,
  ResolvedAnthropic,
  ResolvedCloudinary,
  StoredDoc,
  applyPatch,
  describeChanges,
  isEmptyDoc,
  maskSecret,
  resolveAnthropic,
  resolveCloudinary,
  settingKey,
} from './integrations.logic';
import { TestResult, notConfigured, testAnthropic, testCloudinary } from './integrations.testers';

/**
 * Stored documents are cached per instance for a short time. The API runs
 * serverless with several instances: a write invalidates the cache of the
 * instance that handled it, the others pick the change up within the TTL.
 */
export const INTEGRATIONS_CACHE_TTL_MS = 60_000;

interface StoredEntry {
  doc: StoredDoc;
  updatedAt: Date | null;
  updatedById: string | null;
  /** True when a stored value exists but cannot be decrypted (key changed). */
  unreadable: boolean;
}

export interface Actor {
  id: string;
  username?: string | null;
}

export interface IntegrationsDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  testAnthropic?: (config: AnthropicConfig) => Promise<TestResult>;
  testCloudinary?: (config: CloudinaryConfig) => Promise<TestResult>;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger('IntegrationsService');
  private readonly cache = new Map<IntegrationName, { entry: StoredEntry; expiresAt: number }>();
  private readonly deps: Required<Omit<IntegrationsDeps, 'env'>> & { env?: IntegrationsDeps['env'] };

  constructor(private readonly prisma: PrismaService) {
    this.deps = { now: Date.now, testAnthropic, testCloudinary };
  }

  /** Test seam: overrides env, clock and network checks. */
  withDeps(deps: IntegrationsDeps): this {
    Object.assign(this.deps, deps);
    return this;
  }

  private get env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  // ----- storage -------------------------------------------------------------

  private async load(name: IntegrationName): Promise<StoredEntry> {
    const now = this.deps.now();
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > now) return hit.entry;
    const row = await this.prisma.appSetting.findUnique({ where: { key: settingKey(name) } });
    let entry: StoredEntry = { doc: {}, updatedAt: null, updatedById: null, unreadable: false };
    if (row) {
      entry = { ...entry, updatedAt: row.updatedAt, updatedById: row.updatedById ?? null };
      try {
        const parsed = JSON.parse(decrypt(row.value));
        entry.doc = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        this.logger.warn(`Stored ${name} settings cannot be decrypted (ENCRYPTION_KEY changed?): ignored.`);
        entry.unreadable = true;
      }
    }
    this.cache.set(name, { entry, expiresAt: now + INTEGRATIONS_CACHE_TTL_MS });
    return entry;
  }

  invalidate(name?: IntegrationName) {
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }

  // ----- typed getters (used by the rest of the API) -------------------------

  async resolveAnthropic(): Promise<ResolvedAnthropic> {
    const { doc } = await this.load('anthropic');
    return resolveAnthropic(doc as AnthropicStored, this.env);
  }

  /** Effective Anthropic key + model (DB first, env fallback), or null. */
  async getAnthropicConfig(): Promise<AnthropicConfig | null> {
    return (await this.resolveAnthropic()).config;
  }

  async resolveCloudinary(): Promise<ResolvedCloudinary> {
    const { doc } = await this.load('cloudinary');
    return resolveCloudinary(doc as CloudinaryStored, this.env);
  }

  /** Effective Cloudinary credentials (DB first, env fallback), or null. */
  async getCloudinaryConfig(): Promise<CloudinaryConfig | null> {
    return (await this.resolveCloudinary()).config;
  }

  // ----- admin ---------------------------------------------------------------

  private async usernames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, username: true },
    });
    return new Map(users.map((u) => [u.id, u.username]));
  }

  /** Secret-free status of every integration. */
  async getStatus() {
    this.invalidate(); // the admin page always shows the stored truth
    const [a, c] = await Promise.all([this.load('anthropic'), this.load('cloudinary')]);
    const names = await this.usernames([a.updatedById, c.updatedById]);
    const meta = (e: StoredEntry) => ({
      stored: !isEmptyDoc(e.doc),
      unreadable: e.unreadable,
      updatedAt: e.updatedAt,
      updatedBy: e.updatedById ? (names.get(e.updatedById) ?? null) : null,
    });
    const ra = resolveAnthropic(a.doc as AnthropicStored, this.env);
    const rc = resolveCloudinary(c.doc as CloudinaryStored, this.env);
    return {
      encryptionReady: isEncryptionConfigured(),
      anthropic: {
        configured: !!ra.config,
        source: ra.source,
        apiKeyHint: maskSecret(ra.config?.apiKey),
        model: ra.model,
        storedModel: (a.doc as AnthropicStored).model ?? null,
        defaultModel: DEFAULT_AI_MODEL,
        ...meta(a),
      },
      cloudinary: {
        configured: !!rc.config,
        source: rc.source,
        cloudName: rc.partial.cloudName ?? null,
        apiKeyHint: maskSecret(rc.partial.apiKey),
        apiSecretHint: maskSecret(rc.partial.apiSecret),
        folder: rc.partial.folder ?? null,
        ...meta(c),
      },
    };
  }

  /** Partial update (see `applyPatch` for the empty/null semantics). */
  async update(name: IntegrationName, patch: Record<string, unknown>, actor: Actor) {
    if (!isEncryptionConfigured()) {
      throw new ServiceUnavailableException(
        'ENCRYPTION_KEY absente ou trop courte (32 caractères minimum) : impossible de stocker des secrets de façon sûre.',
      );
    }
    this.invalidate(name);
    const current = await this.load(name);
    // An unreadable document is replaced as a whole by the new values.
    const base = current.unreadable ? {} : current.doc;
    const { next, changed } = applyPatch(name, base, patch);
    if (changed.length || current.unreadable) {
      const key = settingKey(name);
      if (isEmptyDoc(next)) {
        await this.prisma.appSetting.deleteMany({ where: { key } });
      } else {
        const value = encrypt(JSON.stringify(next));
        await this.prisma.appSetting.upsert({
          where: { key },
          create: { key, value, updatedById: actor.id },
          update: { value, updatedById: actor.id },
        });
      }
      this.invalidate(name);
      await this.log('integration.update', actor, name, describeChanges(name, next, changed) || 'reset');
    }
    return this.getStatus();
  }

  /** Removes every stored value of an integration (env fallback applies again). */
  async remove(name: IntegrationName, actor: Actor) {
    const { count } = await this.prisma.appSetting.deleteMany({ where: { key: settingKey(name) } });
    this.invalidate(name);
    if (count) await this.log('integration.remove', actor, name, 'stored settings removed');
    return this.getStatus();
  }

  /** Runs a cheap live check with the effective configuration. */
  async test(name: IntegrationName): Promise<TestResult> {
    this.invalidate(name);
    if (name === 'anthropic') {
      const config = await this.getAnthropicConfig();
      return config ? this.deps.testAnthropic(config) : notConfigured();
    }
    const config = await this.getCloudinaryConfig();
    return config ? this.deps.testCloudinary(config) : notConfigured();
  }

  private async log(action: string, actor: Actor, target: string, details: string) {
    try {
      await this.prisma.adminLog.create({
        data: { action, admin: actor.username ?? actor.id, target, details: details.slice(0, 500) },
      });
    } catch (err) {
      this.logger.warn(`admin log failed: ${(err as Error).message}`);
    }
  }
}
