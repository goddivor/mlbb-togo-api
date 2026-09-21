import { ServiceUnavailableException } from '@nestjs/common';
import { IntegrationsService, INTEGRATIONS_CACHE_TTL_MS } from './integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt, encrypt } from '../common/utils/crypto.util';
import { testAnthropic, testCloudinary } from './integrations.testers';
import { AnthropicClientProvider } from '../ai/ai-client.provider';

const KEY = '0123456789abcdef0123456789abcdef';
const ADMIN = { id: '64b000000000000000000001', username: 'admin' };

/** In-memory stand-in for the Prisma calls used by the service. */
function fakePrisma() {
  const rows = new Map<string, { key: string; value: string; updatedById: string | null; updatedAt: Date }>();
  const logs: any[] = [];
  const prisma = {
    appSetting: {
      findUnique: jest.fn(async ({ where }) => rows.get(where.key) ?? null),
      upsert: jest.fn(async ({ where, create, update }) => {
        const prev = rows.get(where.key);
        const row = prev
          ? { ...prev, ...update, updatedAt: new Date() }
          : { ...create, updatedAt: new Date() };
        rows.set(where.key, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }) => ({ count: rows.delete(where.key) ? 1 : 0 })),
    },
    user: { findMany: jest.fn(async () => [{ id: ADMIN.id, username: ADMIN.username }]) },
    adminLog: { create: jest.fn(async ({ data }) => logs.push(data)) },
  };
  return { prisma, rows, logs };
}

function make(env: Record<string, string | undefined> = {}) {
  let t = 1_000;
  const { prisma, rows, logs } = fakePrisma();
  const service = new IntegrationsService(prisma as unknown as PrismaService).withDeps({
    env,
    now: () => t,
    testAnthropic: jest.fn(async () => ({ ok: true, code: 'ok' as const, message: 'ok' })),
    testCloudinary: jest.fn(async () => ({ ok: true, code: 'ok' as const, message: 'ok' })),
  });
  return { service, prisma, rows, logs, tick: (ms: number) => (t += ms) };
}

describe('IntegrationsService', () => {
  const saved = process.env.ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = saved;
  });

  it('refuses to store secrets without ENCRYPTION_KEY', async () => {
    delete process.env.ENCRYPTION_KEY;
    const { service, rows } = make();
    await expect(service.update('anthropic', { apiKey: 'sk-ant-xxxxxxxx' }, ADMIN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    process.env.ENCRYPTION_KEY = 'too-short';
    await expect(service.update('anthropic', { apiKey: 'sk-ant-xxxxxxxx' }, ADMIN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(rows.size).toBe(0);
    expect((await service.getStatus()).encryptionReady).toBe(false);
  });

  it('stores encrypted values, never returns secrets and logs without them', async () => {
    const { service, rows, logs } = make();
    const status = await service.update('anthropic', { apiKey: 'sk-ant-secret-ABCD', model: 'claude-haiku-4-5' }, ADMIN);
    const row = rows.get('integration.anthropic')!;
    expect(row.value).not.toContain('sk-ant-secret');
    expect(JSON.parse(decrypt(row.value))).toEqual({ apiKey: 'sk-ant-secret-ABCD', model: 'claude-haiku-4-5' });
    expect(row.updatedById).toBe(ADMIN.id);
    expect(status.anthropic).toMatchObject({
      configured: true,
      source: 'db',
      apiKeyHint: '••••ABCD',
      model: 'claude-haiku-4-5',
      updatedBy: 'admin',
    });
    expect(JSON.stringify(status)).not.toContain('sk-ant-secret');
    expect(logs).toEqual([
      expect.objectContaining({
        action: 'integration.update',
        admin: 'admin',
        target: 'anthropic',
        details: 'apiKey updated, model=claude-haiku-4-5',
      }),
    ]);
  });

  it('applies partial updates: empty secret keeps, null removes, unchanged is not logged', async () => {
    const { service, rows, logs } = make();
    await service.update('cloudinary', { cloudName: 'demo', apiKey: '1234567890', apiSecret: 'shh-secret-9876' }, ADMIN);
    await service.update('cloudinary', { cloudName: 'demo', apiKey: '', apiSecret: '', folder: 'mlbb' }, ADMIN);
    let doc = JSON.parse(decrypt(rows.get('integration.cloudinary')!.value));
    expect(doc).toEqual({ cloudName: 'demo', apiKey: '1234567890', apiSecret: 'shh-secret-9876', folder: 'mlbb' });
    await service.update('cloudinary', { cloudName: 'demo', apiKey: '' }, ADMIN);
    expect(logs).toHaveLength(2);
    const status = await service.update('cloudinary', { apiSecret: null }, ADMIN);
    doc = JSON.parse(decrypt(rows.get('integration.cloudinary')!.value));
    expect(doc.apiSecret).toBeUndefined();
    expect(status.cloudinary).toMatchObject({ configured: false, apiSecretHint: null, apiKeyHint: '••••7890' });
    expect(logs[2].details).toBe('apiSecret removed');
  });

  it('falls back to env and deletes the setting when emptied or removed', async () => {
    const { service, rows, logs } = make({ ANTHROPIC_API_KEY: 'env-key-0000-WXYZ' });
    expect(await service.getAnthropicConfig()).toEqual({ apiKey: 'env-key-0000-WXYZ', model: 'claude-opus-5' });
    await service.update('anthropic', { apiKey: 'db-key-1111-ABCD' }, ADMIN);
    expect((await service.getAnthropicConfig())?.apiKey).toBe('db-key-1111-ABCD');
    await service.update('anthropic', { apiKey: null }, ADMIN);
    expect(rows.size).toBe(0);
    expect((await service.getStatus()).anthropic).toMatchObject({ source: 'env', apiKeyHint: '••••WXYZ', stored: false });
    await service.update('anthropic', { model: 'claude-x' }, ADMIN);
    const status = await service.remove('anthropic', ADMIN);
    expect(rows.size).toBe(0);
    expect(status.anthropic.model).toBe('claude-opus-5');
    expect(logs.map((l) => l.action)).toEqual([
      'integration.update',
      'integration.update',
      'integration.update',
      'integration.remove',
    ]);
    await service.remove('anthropic', ADMIN); // nothing stored: no log
    expect(logs).toHaveLength(4);
  });

  it('caches reads for a short TTL and invalidates on write', async () => {
    const { service, prisma, rows, tick } = make();
    await service.getAnthropicConfig();
    await service.getAnthropicConfig();
    expect(prisma.appSetting.findUnique).toHaveBeenCalledTimes(1);
    // A write from another instance is seen once the TTL expires.
    await service.update('anthropic', { apiKey: 'sk-first-00001' }, ADMIN);
    rows.get('integration.anthropic')!.value = encrypt(JSON.stringify({ apiKey: 'sk-other-instance' }));
    expect((await service.getAnthropicConfig())?.apiKey).toBe('sk-first-00001');
    tick(INTEGRATIONS_CACHE_TTL_MS + 1);
    expect((await service.getAnthropicConfig())?.apiKey).toBe('sk-other-instance');
  });

  it('ignores undecryptable values and lets an update replace them', async () => {
    const { service, rows } = make({ ANTHROPIC_API_KEY: 'env-fallback-key' });
    rows.set('integration.anthropic', { key: 'integration.anthropic', value: 'deadbeef:00', updatedById: null, updatedAt: new Date() });
    expect((await service.getAnthropicConfig())?.apiKey).toBe('env-fallback-key');
    expect((await service.getStatus()).anthropic.unreadable).toBe(true);
    await service.update('anthropic', { model: 'claude-y' }, ADMIN);
    expect(JSON.parse(decrypt(rows.get('integration.anthropic')!.value))).toEqual({ model: 'claude-y' });
  });

  it('warns once per undecryptable value, not on every cache refresh', async () => {
    const { service, rows, tick } = make();
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    rows.set('integration.anthropic', { key: 'integration.anthropic', value: 'deadbeef:00', updatedById: null, updatedAt: new Date() });
    await service.getAnthropicConfig();
    tick(INTEGRATIONS_CACHE_TTL_MS + 1);
    await service.getAnthropicConfig();
    await service.getStatus();
    expect(warn).toHaveBeenCalledTimes(1);
    rows.get('integration.anthropic')!.value = 'cafebabe:01';
    tick(INTEGRATIONS_CACHE_TTL_MS + 1);
    await service.getAnthropicConfig();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports stored Cloudinary values apart from the effective (env) ones', async () => {
    const { service } = make({
      CLOUDINARY_CLOUD_NAME: 'env-cloud',
      CLOUDINARY_API_KEY: '111',
      CLOUDINARY_API_SECRET: 'env-secret',
      CLOUDINARY_FOLDER: 'env-folder',
    });
    let status = await service.getStatus();
    expect(status.cloudinary).toMatchObject({
      cloudName: 'env-cloud',
      folder: 'env-folder',
      storedCloudName: null,
      storedFolder: null,
    });
    status = await service.update('cloudinary', { folder: 'db-folder' }, ADMIN);
    expect(status.cloudinary).toMatchObject({
      cloudName: 'env-cloud',
      folder: 'db-folder',
      storedCloudName: null,
      storedFolder: 'db-folder',
    });
  });

  it('tests only configured integrations', async () => {
    const { service } = make();
    expect(await service.test('anthropic')).toMatchObject({ ok: false, code: 'not_configured' });
    await service.update('cloudinary', { cloudName: 'c', apiKey: 'k', apiSecret: 's' }, ADMIN);
    expect(await service.test('cloudinary')).toMatchObject({ ok: true });
  });
});

describe('integration testers', () => {
  it('maps Anthropic errors to codes', async () => {
    const fail = (status: number) => () => ({
      models: { retrieve: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { status })) },
    });
    const cfg = { apiKey: 'k', model: 'claude-z' };
    expect(await testAnthropic(cfg, fail(401))).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await testAnthropic(cfg, fail(404))).toMatchObject({ ok: false, code: 'model_not_found' });
    expect(await testAnthropic(cfg, fail(500))).toMatchObject({ ok: false, code: 'error' });
    const ok = await testAnthropic(cfg, () => ({
      models: { retrieve: jest.fn().mockResolvedValue({ id: 'claude-z', display_name: 'Claude Z' }) },
    }));
    expect(ok).toMatchObject({ ok: true, code: 'ok', detail: 'Claude Z' });
  });

  it('pings Cloudinary with basic auth and maps errors', async () => {
    const cfg = { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret', folder: null };
    const fetchOk = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });
    expect(await testCloudinary(cfg, fetchOk)).toMatchObject({ ok: true, detail: 'ok' });
    const [url, init] = fetchOk.mock.calls[0];
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo/ping');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`);
    const f401 = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await testCloudinary(cfg, f401)).toMatchObject({ ok: false, code: 'unauthorized' });
    const fNet = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await testCloudinary(cfg, fNet)).toMatchObject({ ok: false, code: 'network' });
  });
});

describe('AnthropicClientProvider', () => {
  it('builds the client from the managed key, reuses it and drops it when removed', async () => {
    let cfg: { apiKey: string; model: string } | null = { apiKey: 'k1', model: 'm1' };
    const integrations = {
      resolveAnthropic: jest.fn(async () => ({ config: cfg, model: cfg?.model ?? 'default', source: null })),
    };
    const provider = new AnthropicClientProvider(integrations as any);
    const a = await provider.resolve();
    const b = await provider.resolve();
    expect(a.client).toBeTruthy();
    expect(b.client).toBe(a.client);
    expect(a.model).toBe('m1');
    cfg = { apiKey: 'k2', model: 'm2' };
    const c = await provider.resolve();
    expect(c.client).not.toBe(a.client);
    expect(c.model).toBe('m2');
    cfg = null;
    expect(await provider.resolve()).toEqual({ client: null, model: 'default' });
  });
});
