import { INVALID_TTL_MS, MetaCacheService, RETRY_AFTER_FAILURE_MS } from './meta-cache.service';

const flush = () => new Promise((r) => setImmediate(r));

function fakePrisma(rows: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(rows));
  return {
    store,
    mlbbCache: {
      findUnique: jest.fn(async ({ where }) => store.get(where.key) ?? null),
      upsert: jest.fn(async ({ where, create, update }) => {
        store.set(where.key, store.has(where.key) ? { ...store.get(where.key), ...update } : create);
      }),
    },
  };
}

describe('MetaCacheService', () => {
  afterEach(() => jest.useRealTimers());

  it('loads once, then serves the fresh copy from memory and persists it', async () => {
    const prisma = fakePrisma();
    const cache = new MetaCacheService(prisma as any);
    const loader = jest.fn().mockResolvedValue({ a: 1 });
    expect(await cache.wrap('k', 1000, loader)).toEqual({ a: 1 });
    expect(await cache.wrap('k', 1000, loader)).toEqual({ a: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    await flush();
    expect(prisma.mlbbCache.upsert).toHaveBeenCalledTimes(1);
    expect(JSON.parse(prisma.store.get('k').value)).toEqual({ a: 1 });
  });

  it('shares one in-flight call between concurrent callers', async () => {
    const cache = new MetaCacheService();
    let resolve!: (v: number) => void;
    const loader = jest.fn(() => new Promise<number>((r) => (resolve = r)));
    const p1 = cache.wrap('k', 1000, loader);
    const p2 = cache.wrap('k', 1000, loader);
    await flush();
    resolve(42);
    expect(await Promise.all([p1, p2])).toEqual([42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves a stale copy immediately and refreshes it in the background', async () => {
    jest.useFakeTimers({ now: 0, doNotFake: ['setImmediate'] });
    const cache = new MetaCacheService();
    await cache.wrap('k', 1000, async () => 'v1');
    jest.setSystemTime(5000);
    const loader = jest.fn().mockResolvedValue('v2');
    expect(await cache.wrap('k', 1000, loader)).toBe('v1'); // no wait on upstream
    expect(loader).toHaveBeenCalledTimes(1);
    await flush();
    expect(await cache.wrap('k', 1000, loader)).toBe('v2');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the stale copy when the refresh fails and retries later', async () => {
    jest.useFakeTimers({ now: 0, doNotFake: ['setImmediate'] });
    const cache = new MetaCacheService();
    await cache.wrap('k', 1000, async () => 'v1');
    jest.setSystemTime(5000);
    const failing = jest.fn().mockRejectedValue(new Error('moonton down'));
    expect(await cache.wrap('k', 1000, failing)).toBe('v1');
    await flush();
    expect(cache.peek('k')!.expiresAt).toBe(5000 + RETRY_AFTER_FAILURE_MS);
    expect(await cache.wrap('k', 1000, failing)).toBe('v1');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('throws when the loader fails and nothing is cached', async () => {
    const cache = new MetaCacheService();
    await expect(cache.wrap('k', 1000, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });

  it('reads a fresh copy from the database without calling the loader', async () => {
    const now = Date.now();
    const prisma = fakePrisma({
      k: { key: 'k', value: '[1,2]', fetchedAt: new Date(now), expiresAt: new Date(now + 60_000) },
    });
    const cache = new MetaCacheService(prisma as any);
    const loader = jest.fn();
    expect(await cache.wrap('k', 1000, loader)).toEqual([1, 2]);
    expect(loader).not.toHaveBeenCalled();
  });

  it('serves a stale database copy and refreshes it', async () => {
    const now = Date.now();
    const prisma = fakePrisma({
      k: { key: 'k', value: '"old"', fetchedAt: new Date(now - 10_000), expiresAt: new Date(now - 1) },
    });
    const cache = new MetaCacheService(prisma as any);
    const loader = jest.fn().mockResolvedValue('new');
    expect(await cache.wrap('k', 1000, loader)).toBe('old');
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await cache.wrap('k', 1000, loader)).toBe('new');
  });

  it('does not persist invalid results and keeps the last good copy', async () => {
    jest.useFakeTimers({ now: 0, doNotFake: ['setImmediate'] });
    const prisma = fakePrisma();
    const cache = new MetaCacheService(prisma as any);
    const validate = (v: number[]) => v.length > 0;
    expect(await cache.wrap('k', 1000, async () => [] as number[], { validate })).toEqual([]);
    expect(cache.peek('k')!.expiresAt).toBe(INVALID_TTL_MS);
    await flush();
    expect(prisma.mlbbCache.upsert).not.toHaveBeenCalled();

    cache.clearMemory();
    await cache.wrap('k', 1000, async () => [1], { validate });
    jest.setSystemTime(5000);
    expect(await cache.wrap('k', 1000, async () => [] as number[], { validate })).toEqual([1]);
    await flush();
    expect(await cache.wrap('k', 1000, async () => [2], { validate })).toEqual([1]); // still fresh-ish
  });

  it('survives a database failure', async () => {
    const prisma = {
      mlbbCache: {
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
        upsert: jest.fn().mockRejectedValue(new Error('db down')),
      },
    };
    const cache = new MetaCacheService(prisma as any);
    expect(await cache.wrap('k', 1000, async () => 7)).toBe(7);
    await flush();
  });
});
