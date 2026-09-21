import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GmsClient } from '../mlbb/gms.client';
import { MetaCacheService } from '../mlbb/meta-cache.service';
import { HeroMetaService } from '../mlbb/hero-meta.service';
import { HeroIndexEntry, MlbbService } from '../mlbb/mlbb.service';
import { CatalogEntry } from '../mlbb/gms.mappers';
import {
  APP_ACADEMY,
  LANE_IDS,
  RANK_TIERS,
  RankTier,
  SRC,
  TTL,
  normalizeLane,
  normalizeRank,
} from '../mlbb/gms.constants';
import { ItemGameMeta } from './catalog-sync.mappers';
import {
  HeroLaneBuilds,
  HeroUsage,
  UsageStat,
  compactLaneBuilds,
  countBuilds,
  countItemPairs,
  mapLimit,
  rankHeroUsage,
  selectRelevant,
  usageBy,
} from './catalog-stats.aggregate';

/**
 * Moonton call budget of the build statistics: ONE Academy call per
 * (rank tier, lane) returns the top 3 builds of every hero (~133 records),
 * so a rank tier costs 5 calls and all six tiers 30 calls, at most once per
 * TTL (24 h) each. The lanes are fetched with at most LANE_CONCURRENCY calls
 * in flight, and MetaCacheService serves the stale copy while refreshing.
 */
export const LANE_CONCURRENCY = 2;
const LANE_PAGE_SIZE = 300;
const LANE_TIMEOUT_MS = 15_000;
// After a failed cold load (no cached copy), skip that lane for this long so
// an outage does not turn every page view into new Moonton calls.
export const LANE_FAILURE_BACKOFF_MS = 2 * 60 * 1000;
const LANES = Object.keys(LANE_IDS);

export interface StatsQuery {
  rank?: string | null;
  lane?: string | null;
  limit?: string | number | null;
}

export interface ItemView {
  id: string;
  gameId: number | null;
  name: string;
  icon: string | null;
  gold: number | null;
  type: string | null;
  stats: string | null;
  passive: string | null;
  description: string | null;
  categoryId: number | null;
  category: string | null;
  tier: number | null;
  isComponent: boolean;
  buildsFrom: number[];
  buildsInto: number[];
}

export interface HeroUsageView extends HeroUsage {
  name: string | null;
  image: string | null;
}

interface StatsContext {
  rank: RankTier;
  lane: string | null;
  rows: HeroLaneBuilds[];
  index: Map<number, HeroIndexEntry>;
  available: boolean;
  updatedAt: string | null;
}

const clampLimit = (v: unknown, fallback: number, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

function parseMeta(raw: string | null | undefined): Partial<ItemGameMeta> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const idList = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []);

/**
 * Public catalog pages: the enabled items / battle spells / emblems of the
 * database, enriched with statistics aggregated from the Academy builds of
 * every hero (see the call budget above). The lists never fail because of
 * Moonton: statistics are then empty and `available` is false.
 */
@Injectable()
export class CatalogStatsService {
  private readonly logger = new Logger('CatalogStatsService');
  private readonly failedUntil = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gms: GmsClient,
    private readonly cache: MetaCacheService,
    private readonly mlbb: MlbbService,
    private readonly heroMeta: HeroMetaService,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Academy builds dataset                                             */
  /* ------------------------------------------------------------------ */

  private cacheKey(rank: RankTier, lane: string) {
    return `gms:lane-builds:${rank}:${lane}`;
  }

  /** Top builds of every hero in one lane: a single Moonton call, cached 24 h. */
  private laneBuilds(rank: RankTier, lane: string): Promise<HeroLaneBuilds[]> {
    return this.cache.wrap(
      this.cacheKey(rank, lane),
      TTL.builds,
      async () => {
        const data = await this.gms.callSource(
          APP_ACADEMY,
          SRC.builds,
          {
            pageSize: LANE_PAGE_SIZE,
            pageIndex: 1,
            filters: [
              { field: 'real_road', operator: 'eq', value: LANE_IDS[lane] },
              { field: 'big_rank', operator: 'eq', value: RANK_TIERS[rank] },
            ],
            sorts: [],
          },
          'en',
          { timeoutMs: LANE_TIMEOUT_MS },
        );
        return compactLaneBuilds(data.records, lane);
      },
      { validate: (rows) => rows.length > 0 },
    );
  }

  /** Rows of the requested lanes; a failing lane is skipped (partial data). */
  private async dataset(rank: RankTier, lanes: string[]) {
    const results = await mapLimit(lanes, LANE_CONCURRENCY, async (lane) => {
      const key = this.cacheKey(rank, lane);
      if ((this.failedUntil.get(key) ?? 0) > Date.now()) return null;
      try {
        const rows = await this.laneBuilds(rank, lane);
        this.failedUntil.delete(key);
        return rows;
      } catch (e) {
        this.failedUntil.set(key, Date.now() + LANE_FAILURE_BACKOFF_MS);
        this.logger.warn(`academy builds ${rank}/${lane} unavailable: ${(e as Error).message}`);
        return null;
      }
    });
    const loaded = results.filter((r): r is HeroLaneBuilds[] => r != null);
    const fetched = lanes
      .map((lane) => this.cache.peek(this.cacheKey(rank, lane))?.fetchedAt)
      .filter((t): t is number => typeof t === 'number');
    return {
      rows: loaded.flat(),
      available: loaded.some((r) => r.length > 0),
      updatedAt: fetched.length ? new Date(Math.min(...fetched)).toISOString() : null,
    };
  }

  // Hero names and lanes always come from the English index (one cache key,
  // shared with the heroes page): the lane filter must not depend on the
  // language, and the database catalog is English too.
  private async heroIndex(): Promise<Map<number, HeroIndexEntry>> {
    try {
      return await this.mlbb.heroIndex('en');
    } catch {
      return new Map();
    }
  }

  private async context(q: StatsQuery): Promise<StatsContext> {
    const rank = normalizeRank(q.rank);
    const lane = normalizeLane(q.lane);
    const [data, index] = await Promise.all([
      this.dataset(rank, lane ? [lane] : LANES),
      this.heroIndex(),
    ]);
    const heroLanes = new Map([...index.entries()].map(([id, h]) => [id, h.lanes ?? []]));
    return {
      rank,
      lane,
      rows: selectRelevant(data.rows, heroLanes, lane),
      index,
      available: data.available,
      updatedAt: data.updatedAt,
    };
  }

  private heroViews(list: HeroUsage[], index: Map<number, HeroIndexEntry>): HeroUsageView[] {
    return list.map((h) => ({ ...h, name: index.get(h.heroId)?.name ?? null, image: index.get(h.heroId)?.image ?? null }));
  }

  private meta(ctx: StatsContext) {
    return {
      rank: ctx.rank,
      lane: ctx.lane,
      available: ctx.available,
      updatedAt: ctx.updatedAt,
      buildsAnalysed: countBuilds(ctx.rows),
      heroesCovered: new Set(ctx.rows.map((r) => r.heroId)).size,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Items                                                              */
  /* ------------------------------------------------------------------ */

  private async enabledItems(): Promise<ItemView[]> {
    const rows = await this.prisma.item.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] });
    const enabled = rows.filter((r) => r.enabled !== false);
    const known = new Set(enabled.map((r) => r.gameId).filter((id): id is number => id != null));
    return enabled.map((r) => {
      const m = parseMeta(r.gameMeta);
      return {
        id: r.id,
        gameId: r.gameId ?? null,
        name: r.name,
        icon: r.icon ?? null,
        gold: r.gold ?? null,
        type: r.type ?? null,
        stats: r.stats ?? null,
        passive: r.passive ?? null,
        description: r.description ?? null,
        categoryId: typeof m.categoryId === 'number' ? m.categoryId : null,
        category: typeof m.category === 'string' ? m.category : null,
        tier: typeof m.tier === 'number' ? m.tier : null,
        isComponent: m.isComponent === true,
        // Links to hidden or unknown items are dropped so every node is clickable.
        buildsFrom: idList(m.buildsFrom).filter((id) => known.has(id)),
        buildsInto: idList(m.buildsInto).filter((id) => known.has(id)),
      };
    });
  }

  /** Enabled items with their recipe metadata and the category list. */
  async listItems() {
    const items = await this.enabledItems();
    const categories = new Map<string, { id: number | null; name: string; count: number }>();
    for (const it of items) {
      const name = it.category ?? it.type;
      if (!name) continue;
      const key = name.toLowerCase();
      const c = categories.get(key) ?? { id: it.categoryId, name, count: 0 };
      c.count++;
      categories.set(key, c);
    }
    return {
      total: items.length,
      categories: [...categories.values()].sort((a, b) => (a.id ?? 99) - (b.id ?? 99) || a.name.localeCompare(b.name)),
      items,
    };
  }

  /** Heroes whose top Academy builds contain the item (Moonton id). */
  async itemHeroes(gameId: number, q: StatsQuery = {}) {
    const items = await this.enabledItems();
    if (!items.some((i) => i.gameId === gameId)) throw new NotFoundException('Item not found.');
    const ctx = await this.context(q);
    const limit = clampLimit(q.limit, 10, 30);
    const usage = usageBy(ctx.rows, (b) => b.items).get(gameId) ?? null;
    return {
      ...this.meta(ctx),
      gameId,
      usage,
      heroes: this.heroViews(
        rankHeroUsage(ctx.rows, (b) => b.items.includes(gameId), limit),
        ctx.index,
      ),
    };
  }

  /**
   * Item pairs most often found in the same top Academy build, with the pick
   * rate weighted win rate of those builds. `item` keeps the pairs of one item.
   */
  async synergies(q: StatsQuery & { item?: string | number | null } = {}) {
    const [items, ctx] = await Promise.all([this.enabledItems(), this.context(q)]);
    const byGameId = new Map(items.filter((i) => i.gameId != null).map((i) => [i.gameId as number, i]));
    const item = q.item != null && q.item !== '' ? Number(q.item) : null;
    const limit = clampLimit(q.limit, 30, 100);
    const pairs = countItemPairs(ctx.rows, (id) => byGameId.has(id))
      .filter((p) => item == null || p.a === item || p.b === item)
      .slice(0, limit);
    const ref = (id: number) => {
      const it = byGameId.get(id)!;
      return { id: it.id, gameId: id, name: it.name, icon: it.icon, category: it.category };
    };
    return {
      ...this.meta(ctx),
      item,
      pairs: pairs.map(({ a, b, ...stat }) => ({ items: [ref(a), ref(b)], ...stat })),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Battle spells and emblems                                          */
  /* ------------------------------------------------------------------ */

  /** Enabled battle spells with their usage and the heroes taking them most. */
  async spells(q: StatsQuery = {}) {
    const [rows, ctx] = await Promise.all([
      this.prisma.battleSpell.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
      this.context(q),
    ]);
    const limit = clampLimit(q.limit, 8, 30);
    const usage = usageBy(ctx.rows, (b) => [b.spellId]);
    return {
      ...this.meta(ctx),
      spells: rows
        .filter((r) => r.enabled !== false)
        .map((r) => ({
          id: r.id,
          gameId: r.gameId ?? null,
          name: r.name,
          icon: r.icon ?? null,
          description: r.description ?? null,
          cooldown: r.cooldown ?? null,
          usage: (r.gameId != null && usage.get(r.gameId)) || null,
          heroes:
            r.gameId != null
              ? this.heroViews(rankHeroUsage(ctx.rows, (b) => b.spellId === r.gameId, limit), ctx.index)
              : [],
        })),
    };
  }

  /** Talent names and icons (cached catalog); skipped for a while after a failure. */
  private async talents(): Promise<Map<number, CatalogEntry>> {
    const key = 'talents';
    if ((this.failedUntil.get(key) ?? 0) > Date.now()) return new Map();
    try {
      return new Map((await this.heroMeta.getTalentCatalog('en')).map((t) => [t.id, t]));
    } catch {
      this.failedUntil.set(key, Date.now() + LANE_FAILURE_BACKOFF_MS);
      return new Map();
    }
  }

  /** Enabled emblem sets with their attributes, usage, top heroes and talents. */
  async emblems(q: StatsQuery = {}) {
    const [rows, ctx, talents] = await Promise.all([
      this.prisma.emblem.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
      this.context(q),
      this.talents(),
    ]);
    const limit = clampLimit(q.limit, 8, 30);
    const usage = usageBy(ctx.rows, (b) => [b.emblemId]);
    const talentsOf = (emblemId: number) => {
      const withEmblem = ctx.rows.map((r) => ({ ...r, builds: r.builds.filter((b) => b.emblemId === emblemId) }));
      return [...usageBy(withEmblem, (b) => b.talents).entries()]
        .map(([id, stat]: [number, UsageStat]) => ({
          id,
          name: talents.get(id)?.name ?? null,
          icon: talents.get(id)?.icon ?? null,
          description: talents.get(id)?.description ?? null,
          ...stat,
        }))
        .sort((a, b) => b.builds - a.builds || b.weight - a.weight || a.id - b.id)
        .slice(0, 6);
    };
    return {
      ...this.meta(ctx),
      emblems: rows
        .filter((r) => r.enabled !== false)
        .map((r) => ({
          id: r.id,
          gameId: r.gameId ?? null,
          name: r.name,
          icon: r.icon ?? null,
          type: r.type ?? null,
          attributes: String(r.description ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          usage: (r.gameId != null && usage.get(r.gameId)) || null,
          heroes:
            r.gameId != null
              ? this.heroViews(rankHeroUsage(ctx.rows, (b) => b.emblemId === r.gameId, limit), ctx.index)
              : [],
          talents: r.gameId != null ? talentsOf(r.gameId) : [],
        })),
    };
  }
}
