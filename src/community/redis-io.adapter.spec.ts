import {
  REDIS_URL_ENV_KEYS,
  buildRedisOptions,
  resolveRedisUrl,
  shouldUseRedisAdapter,
} from './redis-io.adapter';

describe('resolveRedisUrl', () => {
  it('returns null when no Redis variable is set', () => {
    expect(resolveRedisUrl({})).toBeNull();
    expect(shouldUseRedisAdapter({})).toBe(false);
  });

  it('ignores empty or whitespace-only values', () => {
    expect(resolveRedisUrl({ REDIS_URL: '', KV_URL: '   ' })).toBeNull();
    expect(shouldUseRedisAdapter({ REDIS_URL: '' })).toBe(false);
  });

  it('reads each supported variable', () => {
    for (const key of REDIS_URL_ENV_KEYS) {
      expect(resolveRedisUrl({ [key]: 'redis://host:6379' })).toBe(
        'redis://host:6379',
      );
      expect(shouldUseRedisAdapter({ [key]: 'redis://host:6379' })).toBe(true);
    }
  });

  it('honours the precedence order of the variables', () => {
    const env = {
      UPSTASH_KV_URL: 'redis://fourth',
      UPSTASH_REDIS_URL: 'redis://third',
      KV_URL: 'redis://second',
      REDIS_URL: 'redis://first',
    };
    expect(resolveRedisUrl(env)).toBe('redis://first');
    delete (env as Record<string, unknown>).REDIS_URL;
    expect(resolveRedisUrl(env)).toBe('redis://second');
    delete (env as Record<string, unknown>).KV_URL;
    expect(resolveRedisUrl(env)).toBe('redis://third');
    delete (env as Record<string, unknown>).UPSTASH_REDIS_URL;
    expect(resolveRedisUrl(env)).toBe('redis://fourth');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveRedisUrl({ KV_URL: '  rediss://host:6379  ' })).toBe(
      'rediss://host:6379',
    );
  });
});

describe('buildRedisOptions', () => {
  it('does not enable TLS for a plain redis:// URL', () => {
    expect(buildRedisOptions('redis://host:6379').tls).toBeUndefined();
  });

  it('enables TLS for a rediss:// URL', () => {
    expect(buildRedisOptions('rediss://host:6379').tls).toEqual({});
  });

  it('disables the per-command retry budget used by pub/sub clients', () => {
    expect(buildRedisOptions('redis://host:6379').maxRetriesPerRequest).toBeNull();
  });
});
