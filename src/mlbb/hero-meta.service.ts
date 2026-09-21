import { Injectable, Logger } from '@nestjs/common';
import { GmsClient } from './gms.client';
import {
  ACADEMY_TREND_SOURCES,
  APP_ACADEMY,
  APP_HEROES,
  LANE_BY_ID,
  LANE_IDS,
  RANK_TIERS,
  RankTier,
  SRC,
  TREND_SOURCES,
  TTL,
  TrendDays,
  WINDOW_SOURCES,
  WindowDays,
  normalizeDays,
  normalizeLane,
  normalizeLang,
  normalizeRank,
  normalizeTrendDays,
} from './gms.constants';
import {
  CatalogEntry,
  MatchupMatrix,
  MetaBuild,
  RankingRow,
  RelationStats,
  SkillCombo,
  SubHeroStat,
  TrendPoint,
  WinRateTimeline,
  computeDeltas,
  mapBuildRecords,
  mapComboRecords,
  mapEquipmentRecords,
  mapMatrixRecords,
  mapRankingRecords,
  mapRelationRecords,
  mapTalentRecords,
  mapTimelineRecords,
  mapTrendRecords,
  pct,
} from './gms.mappers';
import { MetaCacheService } from './meta-cache.service';
import { HeroIndexEntry, MlbbService } from './mlbb.service';

export type RankingSort = 'winRate' | 'pickRate' | 'banRate';

export interface HeroRef {
  heroId: number;
  name: string | null;
  image: string | null;
  /** The other hero's win rate (%), when known. */
  winRate: number | null;
  /** Change of the main hero's win rate (points). */
  increaseWinRate: number;
}

export interface RankingEntry {
  position: number;
  heroId: number;
  name: string | null;
  image: string | null;
  roles: string[];
  lanes: string[];
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
}

/** Legacy overview consumed by the hero modal, pick & ban and the AI module. */
export interface HeroMetaOverview {
  available: boolean;
  winRate: number;
  pickRate: number;
  banRate: number;
  synergy: { best: HeroRef[]; worst: HeroRef[] };
  counters: { strong: HeroRef[]; weak: HeroRef[] };
  combos: SkillCombo[];
  /** Full Academy matrix (every hero), only when requested. */
  matrix?: { counters: HeroRef[]; teammates: HeroRef[] };
}

interface Query {
  rank?: string | null;
  days?: string | number | null;
  lane?: string | number | null;
  lang?: string;
}

const RANK_FIELDS = [
  'main_hero',
  'main_hero_appearance_rate',
  'main_hero_ban_rate',
  'main_hero_channel',
  'main_hero_win_rate',
  'main_heroid',
  'data.sub_hero.hero',
  'data.sub_hero.hero_channel',
  'data.sub_hero.increase_win_rate',
  'data.sub_hero.heroid',
];

const eq = (field: string, value: unknown) => ({ field, operator: 'eq', value });

/**
 * Hero meta straight from Moonton GMS (apps 2669606 and 2713644): rankings by
 * rank tier and window, counters, compatibility, the full matchup matrix,
 * trends, win rate by game length, recommended builds and skill combos.
 * Every upstream call goes through MetaCacheService (memory + DB, SWR).
 */
@Injectable()
export class HeroMetaService {
  private readonly logger = new Logger('HeroMetaService');

  constructor(
    private readonly gms: GmsClient,
    private readonly cache: MetaCacheService,
    private readonly mlbb: MlbbService,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Raw cached datasets                                                */
  /* ------------------------------------------------------------------ */

  private rankingRows(rank: RankTier, days: WindowDays, rawLang: string): Promise<RankingRow[]> {
    const lang = normalizeLang(rawLang);
    return this.cache.wrap(
      `gms:ranking:${rank}:${days}:${lang}`,
      TTL.ranking,
      async () => {
        const data = await this.gms.callSource(
          APP_HEROES,
          WINDOW_SOURCES[days],
          {
            pageSize: 200,
            pageIndex: 1,
            filters: [eq('bigrank', RANK_TIERS[rank]), eq('match_type', '0')],
            sorts: [
              { data: { field: 'main_hero_win_rate', order: 'desc' }, type: 'sequence' },
              { data: { field: 'main_heroid', order: 'desc' }, type: 'sequence' },
            ],
            fields: RANK_FIELDS,
          },
          lang,
        );
        return mapRankingRecords(data.records);
      },
      { validate: (rows) => rows.length > 0 },
    );
  }

  /** Counters (`matchType` 0) or compatibility / per-hero stats (1) for one window. */
  private relation(heroId: number, matchType: 0 | 1, rank: RankTier, days: WindowDays): Promise<RelationStats | null> {
    return this.cache.wrap(
      `gms:relation:${heroId}:${matchType}:${rank}:${days}`,
      TTL.counters,
      async () => {
        const data = await this.gms.callSource(APP_HEROES, WINDOW_SOURCES[days], {
          pageSize: 20,
          pageIndex: 1,
          filters: [eq('match_type', String(matchType)), eq('main_heroid', heroId), eq('bigrank', RANK_TIERS[rank])],
          sorts: [],
        });
        return mapRelationRecords(data.records);
      },
      { validate: (v) => v != null },
    );
  }

  /** Academy per-hero stats (fixed window), used as a fallback for `relation(…, 1)`. */
  private academyStats(heroId: number, rank: RankTier): Promise<RelationStats | null> {
    return this.cache.wrap(
      `gms:academy-stats:${heroId}:${rank}`,
      TTL.stats,
      async () => {
        const data = await this.gms.callSource(APP_ACADEMY, SRC.academyStats, {
          pageSize: 20,
          pageIndex: 1,
          filters: [eq('main_heroid', heroId), eq('bigrank', RANK_TIERS[rank]), eq('match_type', 1)],
          sorts: [],
        });
        return mapRelationRecords(data.records);
      },
      { validate: (v) => v != null },
    );
  }

  /** Full matrix: `camp` 0 = versus every enemy, 1 = with every teammate. */
  private matrix(heroId: number, camp: 0 | 1, rank: RankTier): Promise<MatchupMatrix | null> {
    return this.cache.wrap(
      `gms:matrix:${heroId}:${camp}:${rank}`,
      TTL.matrix,
      async () => {
        const data = await this.gms.callSource(APP_ACADEMY, SRC.matrix, {
          pageSize: 20,
          pageIndex: 1,
          filters: [eq('main_heroid', heroId), eq('camp_type', camp), eq('big_rank', RANK_TIERS[rank])],
          sorts: [],
        });
        return mapMatrixRecords(data.records);
      },
      { validate: (v) => !!v?.entries.length },
    );
  }

  private trendSeries(heroId: number, rank: RankTier, days: TrendDays): Promise<TrendPoint[]> {
    return this.cache.wrap(
      `gms:trend:${heroId}:${rank}:${days}`,
      TTL.trends,
      async () => {
        const body = {
          pageSize: 20,
          pageIndex: 1,
          filters: [eq('main_heroid', heroId), eq('bigrank', RANK_TIERS[rank]), eq('match_type', '1')],
          sorts: [],
        };
        try {
          const points = mapTrendRecords((await this.gms.callSource(APP_HEROES, TREND_SOURCES[days], body)).records);
          if (points.length) return points;
        } catch (e) {
          this.logger.warn(`trend ${heroId}/${days}d unavailable on app ${APP_HEROES}: ${(e as Error).message}`);
        }
        return mapTrendRecords((await this.gms.callSource(APP_ACADEMY, ACADEMY_TREND_SOURCES[days], body)).records);
      },
      { validate: (points) => points.length > 0 },
    );
  }

  private timelineData(heroId: number, rank: RankTier, lane: string): Promise<WinRateTimeline | null> {
    return this.cache.wrap(
      `gms:timeline:${heroId}:${rank}:${lane}`,
      TTL.timeline,
      async () => {
        const data = await this.gms.callSource(APP_ACADEMY, SRC.timeline, {
          pageSize: 20,
          pageIndex: 1,
          filters: [eq('heroid', heroId), eq('big_rank', RANK_TIERS[rank]), eq('real_road', LANE_IDS[lane])],
          sorts: [],
        });
        return mapTimelineRecords(data.records);
      },
      { validate: (v) => !!v?.buckets.length },
    );
  }

  private buildRecords(heroId: number, rank: RankTier, lane: string, rawLang: string): Promise<any[]> {
    const lang = normalizeLang(rawLang);
    return this.cache.wrap(
      `gms:builds:${heroId}:${rank}:${lane}:${lang}`,
      TTL.builds,
      async () =>
        (
          await this.gms.callSource(
            APP_ACADEMY,
            SRC.builds,
            {
              pageSize: 20,
              pageIndex: 1,
              filters: [eq('heroid', heroId), eq('real_road', LANE_IDS[lane]), eq('big_rank', RANK_TIERS[rank])],
              sorts: [],
            },
            lang,
          )
        ).records,
      { validate: (records) => records.length > 0 },
    );
  }

  private catalog(kind: 'equipment' | 'talents', rawLang: string): Promise<CatalogEntry[]> {
    const lang = normalizeLang(rawLang);
    return this.cache.wrap(
      `gms:catalog:${kind}:${lang}`,
      TTL.catalog,
      async () => {
        const data = await this.gms.callSource(
          APP_ACADEMY,
          kind === 'equipment' ? SRC.equipment : SRC.talents,
          { pageSize: 500, pageIndex: 1, filters: [], sorts: [] },
          lang,
        );
        return kind === 'equipment' ? mapEquipmentRecords(data.records) : mapTalentRecords(data.records);
      },
      { validate: (list) => list.length > 0 },
    );
  }

  private academyLanes(heroId: number): Promise<string[]> {
    return this.cache.wrap(
      `gms:lanes:${heroId}`,
      TTL.catalog,
      async () => {
        const data = await this.gms.callSource(APP_ACADEMY, SRC.heroLanes, {
          pageSize: 20,
          pageIndex: 1,
          filters: [eq('hero_id', heroId)],
          sorts: [],
          fields: ['hero_id', 'hero.data.roadsort'],
          object: [],
        });
        const list = data.records?.[0]?.data?.hero?.data?.roadsort;
        return (Array.isArray(list) ? list : [])
          .map((x: any) => LANE_BY_ID[Number(x?.data?.road_sort_id)])
          .filter(Boolean);
      },
      { validate: (lanes) => lanes.length > 0 },
    );
  }

  private combosData(heroId: number, rawLang: string): Promise<SkillCombo[]> {
    const lang = normalizeLang(rawLang);
    return this.cache.wrap(
      `gms:combos:${heroId}:${lang}`,
      TTL.combos,
      async () =>
        mapComboRecords(
          (
            await this.gms.callSource(
              APP_HEROES,
              SRC.combos,
              { pageSize: 20, pageIndex: 1, filters: [eq('hero_id', heroId)], sorts: [], object: [SRC.combosObject] },
              lang,
            )
          ).records,
        ),
      { validate: (list) => list.length > 0 },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private async index(lang: string): Promise<Map<number, HeroIndexEntry>> {
    try {
      return await this.mlbb.heroIndex(lang);
    } catch {
      return new Map();
    }
  }

  private toRefs(list: Array<SubHeroStat | { heroId: number; winRate: number | null; increaseWinRate: number; image?: string | null }>, index: Map<number, HeroIndexEntry>): HeroRef[] {
    return (list ?? []).map((s) => {
      const info = index.get(s.heroId);
      return {
        heroId: s.heroId,
        name: info?.name ?? null,
        image: info?.image ?? (s as any).image ?? null,
        winRate: s.winRate ?? null,
        increaseWinRate: s.increaseWinRate,
      };
    });
  }

  /** Lanes a hero is played in (hero list first, Academy as a fallback). */
  async heroLanes(heroId: number, lang = 'en'): Promise<string[]> {
    const fromIndex = (await this.index(lang)).get(heroId)?.lanes ?? [];
    if (fromIndex.length) return fromIndex;
    try {
      return await this.academyLanes(heroId);
    } catch {
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** Win/pick/ban ranking for a rank tier and window, filterable and sortable. */
  async getRanking(q: Query & { role?: string | null; sort?: string | null; order?: string | null } = {}) {
    const rank = normalizeRank(q.rank);
    const days = normalizeDays(q.days);
    const lang = q.lang || 'en';
    const sort: RankingSort = (['winRate', 'pickRate', 'banRate'] as const).includes(q.sort as RankingSort)
      ? (q.sort as RankingSort)
      : 'winRate';
    const order = q.order === 'asc' ? 'asc' : 'desc';
    const role = q.role ? String(q.role).toLowerCase() : null;
    const lane = normalizeLane(q.lane);

    const [rows, index] = await Promise.all([this.rankingRows(rank, days, lang), this.index(lang)]);
    const heroes = rows
      .filter((r) => r.heroId != null)
      .map((r) => {
        const info = index.get(r.heroId!);
        return {
          heroId: r.heroId!,
          name: r.name ?? info?.name ?? null,
          image: info?.image ?? r.image ?? null,
          roles: info?.roles ?? [],
          lanes: info?.lanes ?? [],
          winRate: pct(r.winRate),
          pickRate: pct(r.pickRate),
          banRate: pct(r.banRate),
        };
      })
      .filter((h) => (!role || h.roles.includes(role)) && (!lane || h.lanes.includes(lane)))
      .sort((a, b) => {
        const d = (a[sort] ?? -1) - (b[sort] ?? -1);
        return (order === 'asc' ? d : -d) || a.heroId - b.heroId;
      })
      .map((h, i): RankingEntry => ({ position: i + 1, ...h }));

    return { rank, days, sort, order, role, lane, total: heroes.length, heroes };
  }

  /** Legacy `/mlbb/ranking` shape (rates as fractions). */
  async getHeroRanking(
    opts: { rank?: string; days?: number; limit?: number; sort?: RankingSort; order?: 'asc' | 'desc'; lang?: string } = {},
  ): Promise<{ total: number; ranking: RankingRow[] }> {
    const rows = await this.rankingRows(normalizeRank(opts.rank), normalizeDays(opts.days), opts.lang || 'en');
    const sort = opts.sort ?? 'winRate';
    const dir = opts.order === 'asc' ? 1 : -1;
    const ranking = [...rows].sort((a, b) => dir * ((a[sort] ?? -1) - (b[sort] ?? -1)));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : ranking.length;
    return { total: rows.length, ranking: ranking.slice(0, limit) };
  }

  /** 5 best / 5 worst matchups for a window (`strong` = heroes this hero beats). */
  async getCounters(heroId: number, q: Query = {}) {
    const rank = normalizeRank(q.rank);
    const days = normalizeDays(q.days);
    const [rel, index] = await Promise.all([this.relation(heroId, 0, rank, days), this.index(q.lang || 'en')]);
    return {
      heroId,
      rank,
      days,
      strong: this.toRefs(rel?.best ?? [], index),
      weak: this.toRefs(rel?.worst ?? [], index),
    };
  }

  /** 5 best / 5 worst teammates for a window. */
  async getCompatibility(heroId: number, q: Query = {}) {
    const rank = normalizeRank(q.rank);
    const days = normalizeDays(q.days);
    const [rel, index] = await Promise.all([this.relation(heroId, 1, rank, days), this.index(q.lang || 'en')]);
    return {
      heroId,
      rank,
      days,
      best: this.toRefs(rel?.best ?? [], index),
      worst: this.toRefs(rel?.worst ?? [], index),
    };
  }

  /** Full matrix: every enemy (`counters`) and every teammate, highest increase first. */
  async getMatchups(heroId: number, q: Query = {}) {
    const rank = normalizeRank(q.rank);
    const [vs, withAlly, index] = await Promise.all([
      this.matrix(heroId, 0, rank),
      this.matrix(heroId, 1, rank),
      this.index(q.lang || 'en'),
    ]);
    return {
      heroId,
      rank,
      counters: this.toRefs(vs?.entries ?? [], index),
      teammates: this.toRefs(withAlly?.entries ?? [], index),
    };
  }

  /** Win/pick/ban for a rank tier and window, with deltas and ranking positions. */
  async getHeroStats(heroId: number, q: Query = {}) {
    const rank = normalizeRank(q.rank);
    const days = normalizeDays(q.days);
    const lang = q.lang || 'en';

    let source = 'gms';
    let rel: RelationStats | null = null;
    try {
      rel = await this.relation(heroId, 1, rank, days);
    } catch (e) {
      this.logger.warn(`stats ${heroId} unavailable, trying Academy: ${(e as Error).message}`);
    }
    if (!rel) {
      rel = await this.academyStats(heroId, rank);
      source = 'academy';
    }

    const [rows, series, index] = await Promise.all([
      this.rankingRows(rank, days, lang).catch(() => [] as RankingRow[]),
      this.trendSeries(heroId, rank, 30).catch(() => [] as TrendPoint[]),
      this.index(lang),
    ]);

    const position = (field: 'winRate' | 'pickRate' | 'banRate') => {
      const sorted = rows.filter((r) => r[field] != null).sort((a, b) => (b[field] as number) - (a[field] as number));
      const i = sorted.findIndex((r) => r.heroId === heroId);
      return i >= 0 ? i + 1 : null;
    };
    const info = index.get(heroId);

    return {
      heroId,
      name: info?.name ?? rel?.name ?? null,
      image: info?.image ?? rel?.image ?? null,
      rank,
      days,
      source,
      available: !!rel && rel.winRate != null,
      winRate: rel?.winRate ?? null,
      pickRate: rel?.pickRate ?? null,
      banRate: rel?.banRate ?? null,
      deltas: computeDeltas(series, days),
      positions: { winRate: position('winRate'), pickRate: position('pickRate'), banRate: position('banRate') },
      total: rows.length,
      teammates: this.toRefs(rel?.best ?? [], index),
    };
  }

  /** Daily win/pick/ban series over 7, 15 or 30 days (oldest first). */
  async getTrends(heroId: number, q: Query = {}) {
    const rank = normalizeRank(q.rank);
    const days = normalizeTrendDays(q.days);
    return { heroId, rank, days, points: await this.trendSeries(heroId, rank, days) };
  }

  /** Win rate by game length for one lane (defaults to the hero's main lane). */
  async getTimeline(heroId: number, q: Query = {}) {
    const rank = normalizeRank(q.rank);
    const lanes = await this.heroLanes(heroId, q.lang || 'en');
    const lane = normalizeLane(q.lane) ?? lanes[0] ?? null;
    if (!lane) return { heroId, rank, lane: null, lanes, totalWinRate: null, buckets: [] };
    const data = await this.timelineData(heroId, rank, lane);
    return { heroId, rank, lane, lanes, totalWinRate: data?.totalWinRate ?? null, buckets: data?.buckets ?? [] };
  }

  /** Academy recommended builds (items, emblem, talents, spell) with win/pick rates. */
  async getBuilds(heroId: number, q: Query = {}) {
    const rank = normalizeRank(q.rank);
    const lang = q.lang || 'en';
    const lanes = await this.heroLanes(heroId, lang);
    const lane = normalizeLane(q.lane) ?? lanes[0] ?? null;
    if (!lane) return { heroId, rank, lane: null, lanes, builds: [] as MetaBuild[] };
    const [records, items, talents] = await Promise.all([
      this.buildRecords(heroId, rank, lane, lang),
      this.catalog('equipment', lang).catch(() => [] as CatalogEntry[]),
      this.catalog('talents', lang).catch(() => [] as CatalogEntry[]),
    ]);
    const builds = mapBuildRecords(
      records,
      new Map(items.map((i) => [i.id, i])),
      new Map(talents.map((t) => [t.id, t])),
    );
    return { heroId, rank, lane, lanes, builds };
  }

  /** Emblem talents catalog (cached, shared with the builds panel). */
  getTalentCatalog(lang = 'en'): Promise<CatalogEntry[]> {
    return this.catalog('talents', lang);
  }

  async getCombos(heroId: number, lang = 'en') {
    return { heroId, combos: await this.combosData(heroId, lang) };
  }

  /**
   * Overview used by the hero modal, pick & ban and the AI coach. Each part
   * degrades independently (empty lists) when Moonton is unavailable.
   */
  async getHeroMeta(heroId: number, lang = 'en', opts: { matrix?: boolean } = {}): Promise<HeroMetaOverview> {
    const safe = <T>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch((e) => {
        this.logger.warn(`meta ${heroId}: ${(e as Error).message}`);
        return fallback;
      });
    // The rate records share their cache keys (and in-flight calls) with
    // getCounters/getCompatibility, so they add no upstream request and no
    // extra wait when Moonton is slow.
    const [counters, compat, combos, matrix, vsRel, withRel] = await Promise.all([
      safe(this.getCounters(heroId, { lang }), null),
      safe(this.getCompatibility(heroId, { lang }), null),
      safe(this.combosData(heroId, lang), [] as SkillCombo[]),
      opts.matrix ? safe(this.getMatchups(heroId, { lang }), null) : Promise.resolve(null),
      safe(this.relation(heroId, 0, 'all', 1), null),
      safe(this.relation(heroId, 1, 'all', 1), null),
    ]);
    // Rates come from the counters record (same window); compatibility as a fallback.
    const rel = vsRel ?? withRel;

    const overview: HeroMetaOverview = {
      available: rel?.winRate != null,
      winRate: rel?.winRate ?? 0,
      pickRate: rel?.pickRate ?? 0,
      banRate: rel?.banRate ?? 0,
      synergy: { best: compat?.best ?? [], worst: compat?.worst ?? [] },
      counters: { strong: counters?.strong ?? [], weak: counters?.weak ?? [] },
      combos,
    };
    if (opts.matrix) overview.matrix = { counters: matrix?.counters ?? [], teammates: matrix?.teammates ?? [] };
    return overview;
  }
}
