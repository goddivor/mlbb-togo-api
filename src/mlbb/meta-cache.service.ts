import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CacheEntry<T = unknown> {
  value: T;
  fetchedAt: number;
  expiresAt: number;
}

export interface WrapOptions<T> {
  /** Results failing this check are served but kept only briefly (not persisted). */
  validate?: (value: T) => boolean;
}

// After a failed refresh, keep serving the stale copy and retry after this delay.
export const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
// Invalid (e.g. empty) results are kept in memory this long only.
export const INVALID_TTL_MS = 5 * 60 * 1000;
const MAX_MEMORY_ENTRIES = 3000;

/**
 * Two-level cache (memory + MongoDB `MlbbCache`) with stale-while-revalidate:
 * - fresh copy (memory or DB): served directly;
 * - stale copy: served immediately, refreshed in the background;
 * - no copy: the loader runs (concurrent callers share one in-flight call).
 * A failing refresh never hides a stale copy. The DB layer is best effort.
 */
@Injectable()
export class MetaCacheService {
  private readonly logger = new Logger('MetaCache');
  private readonly memory = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /** Test/diagnostic helper. */
  peek<T>(key: string): CacheEntry<T> | undefined {
    return this.memory.get(key) as CacheEntry<T> | undefined;
  }

  clearMemory() {
    this.memory.clear();
  }

  async wrap<T>(key: string, ttlMs: number, loader: () => Promise<T>, opts: WrapOptions<T> = {}): Promise<T> {
    const now = Date.now();
    let entry = this.memory.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expiresAt > now) return entry.value;

    if (!entry) {
      const stored = await this.readDb<T>(key);
      if (stored) {
        this.remember(key, stored);
        entry = stored;
        if (stored.expiresAt > now) return stored.value;
      }
    }

    if (entry) {
      // Stale: answer now, refresh behind the scenes.
      this.refresh(key, ttlMs, loader, opts).catch((e) =>
        this.logger.warn(`background refresh failed for ${key}: ${(e as Error).message}`),
      );
      return entry.value;
    }
    return this.refresh(key, ttlMs, loader, opts);
  }

  private refresh<T>(key: string, ttlMs: number, loader: () => Promise<T>, opts: WrapOptions<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const run = (async () => {
      try {
        const value = await loader();
        const now = Date.now();
        const valid = opts.validate ? opts.validate(value) : true;
        const previous = this.memory.get(key) as CacheEntry<T> | undefined;
        if (!valid && previous) {
          // Keep the last good copy rather than replacing it with an empty one.
          previous.expiresAt = now + RETRY_AFTER_FAILURE_MS;
          return previous.value;
        }
        const entry: CacheEntry<T> = {
          value,
          fetchedAt: now,
          expiresAt: now + (valid ? ttlMs : INVALID_TTL_MS),
        };
        this.remember(key, entry);
        if (valid) void this.writeDb(key, entry);
        return value;
      } catch (e) {
        const stale = this.memory.get(key) as CacheEntry<T> | undefined;
        if (stale) {
          stale.expiresAt = Date.now() + RETRY_AFTER_FAILURE_MS;
          this.logger.warn(`refresh failed for ${key}, serving stale copy: ${(e as Error).message}`);
          return stale.value;
        }
        throw e;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, run);
    return run;
  }

  private remember(key: string, entry: CacheEntry) {
    if (this.memory.size >= MAX_MEMORY_ENTRIES && !this.memory.has(key)) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, entry);
  }

  private async readDb<T>(key: string): Promise<CacheEntry<T> | null> {
    if (!this.prisma) return null;
    try {
      const row = await (this.prisma as any).mlbbCache.findUnique({ where: { key } });
      if (!row) return null;
      return {
        value: JSON.parse(row.value) as T,
        fetchedAt: new Date(row.fetchedAt).getTime(),
        expiresAt: new Date(row.expiresAt).getTime(),
      };
    } catch (e) {
      this.logger.debug(`cache read failed for ${key}: ${(e as Error).message}`);
      return null;
    }
  }

  private async writeDb(key: string, entry: CacheEntry): Promise<void> {
    if (!this.prisma) return;
    try {
      const data = {
        value: JSON.stringify(entry.value),
        fetchedAt: new Date(entry.fetchedAt),
        expiresAt: new Date(entry.expiresAt),
      };
      await (this.prisma as any).mlbbCache.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    } catch (e) {
      this.logger.debug(`cache write failed for ${key}: ${(e as Error).message}`);
    }
  }
}
