// Pure logic of the admin-managed third-party integrations (Anthropic,
// Cloudinary): stored document shapes, partial update semantics, environment
// fallback and masking. Kept free of Nest/Prisma so it is trivially testable.

import { DEFAULT_AI_MODEL } from '../ai/ai-llm';

export const INTEGRATIONS = ['anthropic', 'cloudinary'] as const;
export type IntegrationName = (typeof INTEGRATIONS)[number];

export function isIntegrationName(value: string): value is IntegrationName {
  return (INTEGRATIONS as readonly string[]).includes(value);
}

/** AppSetting key holding the encrypted document of an integration. */
export const settingKey = (name: IntegrationName) => `integration.${name}`;

/** Stored (decrypted) documents. Every field is optional: missing = env fallback. */
export interface AnthropicStored {
  apiKey?: string;
  model?: string;
}

export interface CloudinaryStored {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
  folder?: string;
}

export type StoredDoc = AnthropicStored | CloudinaryStored;

/** Fields that are secrets (write-only, masked in every response). */
export const SECRET_FIELDS: Record<IntegrationName, readonly string[]> = {
  anthropic: ['apiKey'],
  cloudinary: ['apiKey', 'apiSecret'],
};

/** Every field an admin may set, secrets included. */
export const FIELDS: Record<IntegrationName, readonly string[]> = {
  anthropic: ['apiKey', 'model'],
  cloudinary: ['cloudName', 'apiKey', 'apiSecret', 'folder'],
};

export type Source = 'db' | 'env' | null;

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string | null;
}

type Env = Record<string, string | undefined>;

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

/**
 * Masked hint of a secret: its last 4 characters. Short values (< 8 chars)
 * are fully hidden since 4 characters would reveal half of them.
 */
export function maskSecret(value: string | null | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  if (v.length < 8) return '••••';
  return `••••${v.slice(-4)}`;
}

/**
 * Applies a partial update to a stored document.
 * - secret fields: `undefined` or `''` keeps the current value, `null`
 *   removes it, any other string replaces it;
 * - plain fields: `undefined` keeps, `''` or `null` clears (back to the
 *   env/default value), any other string replaces.
 * Returns the next document and the list of changed fields (names only).
 */
export function applyPatch(
  name: IntegrationName,
  current: StoredDoc,
  patch: Record<string, unknown>,
): { next: StoredDoc; changed: string[] } {
  const next: Record<string, string | undefined> = { ...(current as Record<string, string | undefined>) };
  const changed: string[] = [];
  const secrets = SECRET_FIELDS[name];
  for (const field of FIELDS[name]) {
    if (!(field in patch)) continue;
    const raw = patch[field];
    if (raw === undefined) continue;
    const isSecret = secrets.includes(field);
    let value: string | undefined;
    if (raw === null) value = undefined;
    else if (typeof raw !== 'string') continue;
    else if (!raw.trim()) {
      if (isSecret) continue; // empty secret = keep the stored one
      value = undefined;
    } else value = raw.trim();
    if (next[field] !== value) {
      changed.push(field);
      if (value === undefined) delete next[field];
      else next[field] = value;
    }
  }
  return { next: next as StoredDoc, changed };
}

/** True when the document holds no field at all (the setting can be deleted). */
export function isEmptyDoc(doc: StoredDoc): boolean {
  return !Object.values(doc).some((v) => clean(v));
}

/** Parses `cloudinary://<key>:<secret>@<cloud>` (the official env format). */
export function parseCloudinaryUrl(url: string | undefined): Partial<CloudinaryStored> {
  const v = clean(url);
  if (!v) return {};
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@([^/?#]+)/.exec(v);
  if (!m) return {};
  return { apiKey: decodeURIComponent(m[1]), apiSecret: decodeURIComponent(m[2]), cloudName: m[3] };
}

export interface ResolvedAnthropic {
  config: AnthropicConfig | null;
  model: string;
  source: Source;
}

/** Effective Anthropic settings: stored values first, then env, then defaults. */
export function resolveAnthropic(stored: AnthropicStored, env: Env): ResolvedAnthropic {
  const dbKey = clean(stored.apiKey);
  const envKey = clean(env.ANTHROPIC_API_KEY);
  const apiKey = dbKey ?? envKey;
  const model = clean(stored.model) ?? clean(env.AI_MODEL) ?? DEFAULT_AI_MODEL;
  return {
    config: apiKey ? { apiKey, model } : null,
    model,
    source: dbKey ? 'db' : envKey ? 'env' : null,
  };
}

export interface ResolvedCloudinary {
  config: CloudinaryConfig | null;
  partial: Partial<CloudinaryStored>;
  source: Source;
}

/** Effective Cloudinary settings, field by field: stored, then CLOUDINARY_* env. */
export function resolveCloudinary(stored: CloudinaryStored, env: Env): ResolvedCloudinary {
  const fromUrl = parseCloudinaryUrl(env.CLOUDINARY_URL);
  const envDoc: CloudinaryStored = {
    cloudName: clean(env.CLOUDINARY_CLOUD_NAME) ?? fromUrl.cloudName,
    apiKey: clean(env.CLOUDINARY_API_KEY) ?? fromUrl.apiKey,
    apiSecret: clean(env.CLOUDINARY_API_SECRET) ?? fromUrl.apiSecret,
    folder: clean(env.CLOUDINARY_FOLDER),
  };
  const pickField = (f: keyof CloudinaryStored) => clean(stored[f]) ?? clean(envDoc[f]);
  const partial: Partial<CloudinaryStored> = {
    cloudName: pickField('cloudName'),
    apiKey: pickField('apiKey'),
    apiSecret: pickField('apiSecret'),
    folder: pickField('folder'),
  };
  const complete = !!(partial.cloudName && partial.apiKey && partial.apiSecret);
  const source: Source = clean(stored.apiSecret) ? 'db' : clean(envDoc.apiSecret) ? 'env' : null;
  return {
    config: complete
      ? {
          cloudName: partial.cloudName as string,
          apiKey: partial.apiKey as string,
          apiSecret: partial.apiSecret as string,
          folder: partial.folder ?? null,
        }
      : null,
    partial,
    source,
  };
}

/** Human-readable (secret-free) summary of changed fields for the AdminLog. */
export function describeChanges(name: IntegrationName, next: StoredDoc, changed: string[]): string {
  const secrets = SECRET_FIELDS[name];
  const doc = next as Record<string, string | undefined>;
  return changed
    .map((f) => {
      const v = doc[f];
      if (secrets.includes(f)) return `${f} ${v ? 'updated' : 'removed'}`;
      return v ? `${f}=${v}` : `${f} cleared`;
    })
    .join(', ');
}
