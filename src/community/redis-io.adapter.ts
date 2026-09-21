import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { RedisOptions } from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * Environment variables that may carry the Redis connection string, in order of
 * precedence. Vercel's Upstash integration injects one of the KV/UPSTASH ones
 * depending on how the store was provisioned, so all of them are supported.
 */
export const REDIS_URL_ENV_KEYS = [
  'REDIS_URL',
  'KV_URL',
  'UPSTASH_REDIS_URL',
  'UPSTASH_KV_URL',
] as const;

export type RedisEnv = Record<string, string | undefined>;

/**
 * First non-empty Redis URL found in the environment, or null when none is set.
 * Pure function: no network, no side effect.
 */
export function resolveRedisUrl(env: RedisEnv = process.env): string | null {
  for (const key of REDIS_URL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Whether the socket.io Redis adapter should be wired in. When false the
 * default in-memory adapter is kept (local dev, single-instance hosts).
 */
export function shouldUseRedisAdapter(env: RedisEnv = process.env): boolean {
  return resolveRedisUrl(env) !== null;
}

/**
 * Connection options for a Redis URL. `rediss://` URLs are TLS, which ioredis
 * only enables when the `tls` option is present.
 */
export function buildRedisOptions(url: string): RedisOptions {
  const options: RedisOptions = {
    // The pub/sub clients must never give up on a command because of a retry
    // budget: the adapter relies on long-lived subscriptions.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  };
  if (url.startsWith('rediss://')) {
    options.tls = {};
  }
  return options;
}

/**
 * socket.io adapter that broadcasts through Redis when a Redis URL is
 * configured, so realtime events reach clients served by other instances
 * (serverless functions, multiple containers). Falls back to the stock
 * in-memory adapter when no URL is set or the connection fails.
 */
export class RedisIoAdapter extends IoAdapter {
  private static readonly logger = new Logger(RedisIoAdapter.name);

  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  /**
   * Connects the pub/sub clients. Returns true when the Redis adapter is
   * active, false when the in-memory adapter is kept. Never throws.
   */
  async connect(env: RedisEnv = process.env): Promise<boolean> {
    const url = resolveRedisUrl(env);
    if (!url) {
      RedisIoAdapter.logger.log(
        'No Redis URL configured, using the in-memory socket.io adapter',
      );
      return false;
    }

    try {
      const pubClient = new Redis(url, buildRedisOptions(url));
      const subClient = pubClient.duplicate();
      this.clients = [pubClient, subClient];
      // Keep late connection drops from bubbling up as unhandled errors.
      for (const client of this.clients) {
        client.on('error', (error: Error) => {
          RedisIoAdapter.logger.warn(`Redis client error: ${error.message}`);
        });
      }
      await Promise.all(this.clients.map((client) => client.connect()));
      this.adapterConstructor = createAdapter(pubClient, subClient);
      RedisIoAdapter.logger.log('socket.io Redis adapter connected');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      RedisIoAdapter.logger.warn(
        `Redis unavailable (${message}), falling back to the in-memory socket.io adapter`,
      );
      await this.disconnect();
      this.adapterConstructor = null;
      return false;
    }
  }

  /** Closes the pub/sub clients, if any. Never throws. */
  async disconnect(): Promise<void> {
    const clients = this.clients;
    this.clients = [];
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }),
    );
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
