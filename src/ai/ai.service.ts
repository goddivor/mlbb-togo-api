import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MlbbService } from '../mlbb/mlbb.service';
import { parseJson } from '../common/utils/json.util';
import {
  ANTHROPIC_CLIENT,
  AnthropicLike,
  DEFAULT_AI_MODEL,
  callStructured,
  metaBlock,
  playerBlock,
  systemPrompt,
} from './ai-llm';
import {
  analysisHeuristic,
  buildHeuristic,
  coachHeuristic,
  counterPicksHeuristic,
  recommendHeroesHeuristic,
  winRateOf,
} from './ai-heuristics';
import {
  validateAnalysis,
  validateBuild,
  validateCoach,
  validateCounters,
  validateRecommendations,
} from './ai-validate';
import { RateLimiter, TtlCache } from './ai-store';
import {
  AiLang,
  AnalysisResponse,
  BuildResponse,
  CatalogHero,
  CoachResponse,
  CounterResponse,
  HeroMeta,
  HeroRecommendationsResponse,
  PlayerContext,
} from './ai.types';

export const AI_RATE_LIMIT = 20; // requests per user per window
export const AI_RATE_WINDOW_MS = 60 * 60 * 1000;
export const AI_CACHE_TTL_MS = 60 * 60 * 1000;

const HERO_SELECT = {
  id: true,
  name: true,
  role: true,
  roles: true,
  laneKeys: true,
  image: true,
  thumb: true,
  heroId: true,
  speciality: true,
  stats: true,
} as const;

@Injectable()
export class AiService {
  private readonly logger = new Logger('AiService');
  readonly model: string;
  private readonly limiter: RateLimiter;
  private readonly cache: TtlCache<unknown>;
  // Moonton heroId by lowercase name, resolved lazily when the catalog row has none.
  private moontonIds: { map: Map<string, number>; expiresAt: number } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly mlbb: MlbbService,
    @Optional() @Inject(ANTHROPIC_CLIENT) private readonly client: AnthropicLike | null = null,
    @Optional() limiter?: RateLimiter,
    @Optional() cache?: TtlCache<unknown>,
  ) {
    this.model = this.config.get<string>('AI_MODEL') || DEFAULT_AI_MODEL;
    this.limiter = limiter ?? new RateLimiter(AI_RATE_LIMIT, AI_RATE_WINDOW_MS);
    this.cache = cache ?? new TtlCache(AI_CACHE_TTL_MS);
    if (this.client) this.logger.log(`Anthropic client ready (model ${this.model}).`);
    else this.logger.warn('ANTHROPIC_API_KEY not set: AI endpoints run in heuristic mode.');
  }

  get enabled(): boolean {
    return !!this.client;
  }

  getStatus() {
    return { enabled: this.enabled, model: this.model, mode: this.enabled ? 'llm' : 'heuristic' };
  }

  // ----- quota + cache -----------------------------------------------------

  /**
   * Serves from cache when possible (cache hits never consume quota), otherwise
   * consumes one unit of the user's quota and computes the value.
   */
  private async cachedOrLimited<T>(userId: string, cacheKey: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(cacheKey) as T | undefined;
    if (hit !== undefined) return hit;
    const q = this.limiter.consume(userId);
    if (!q.allowed) {
      const retryAfter = Math.max(1, Math.ceil((q.resetAt - Date.now()) / 1000));
      throw new HttpException(
        { statusCode: 429, message: 'Quota IA atteint (20 requêtes par heure).', retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const value = await compute();
    this.cache.set(cacheKey, value);
    return value;
  }

  private key(kind: string, payload: unknown): string {
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
    return `${kind}:${hash}`;
  }

  // ----- data access --------------------------------------------------------

  async loadPlayer(userId: string): Promise<PlayerContext> {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('Utilisateur introuvable.');
    return {
      id: u.id,
      username: u.username,
      rank: u.rank,
      role: u.role,
      wins: u.wins,
      losses: u.losses,
      mvpCount: u.mvpCount,
      streak: u.streak,
      favoriteHeroes: parseJson<string[]>(u.favoriteHeroes, []),
      gameFrequentHeroes: parseJson<any[]>(u.gameFrequentHeroes, []),
      gameRoles: parseJson<any[]>(u.gameRoles, []),
      gameStats: parseJson<Record<string, any>>(u.gameStats, {}),
    };
  }

  async loadCatalog(): Promise<CatalogHero[]> {
    const rows = await this.prisma.hero.findMany({ orderBy: { name: 'asc' }, select: HERO_SELECT });
    return rows as CatalogHero[];
  }

  async loadHero(id: string): Promise<CatalogHero> {
    let row: any = null;
    try {
      row = await this.prisma.hero.findUnique({ where: { id }, select: HERO_SELECT });
    } catch (err) {
      // Malformed ids are rejected by the DTO; anything else Prisma throws here
      // (e.g. an id that is not a valid ObjectId) is reported as not found.
      this.logger.debug(`hero lookup failed for ${id}: ${(err as Error).message}`);
    }
    if (!row) throw new NotFoundException(`Héros introuvable: ${id}`);
    return row as CatalogHero;
  }

  /** Resolves the Moonton heroId of a catalog row (falls back to the live hero list by name). */
  private async moontonId(hero: CatalogHero): Promise<number | null> {
    if (hero.heroId) return hero.heroId;
    const now = Date.now();
    if (!this.moontonIds || this.moontonIds.expiresAt < now) {
      try {
        const { heroes } = await this.mlbb.getHeroes();
        const map = new Map<string, number>();
        for (const h of heroes) if (h?.name && h.heroId != null) map.set(String(h.name).toLowerCase(), Number(h.heroId));
        this.moontonIds = { map, expiresAt: now + 6 * 60 * 60 * 1000 };
      } catch (err) {
        this.logger.warn(`Moonton hero list unavailable: ${(err as Error).message}`);
        return null;
      }
    }
    return this.moontonIds.map.get(hero.name.toLowerCase()) ?? null;
  }

  async loadMeta(hero: CatalogHero, lang: AiLang): Promise<HeroMeta | null> {
    const id = await this.moontonId(hero);
    if (!id) return null;
    try {
      return (await this.mlbb.getHeroMeta(id, lang)) as HeroMeta;
    } catch (err) {
      this.logger.warn(`getHeroMeta(${id}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Meta win rate (%) by lowercase hero name from the cached ranking, or empty when unavailable. */
  private async metaWinRates(lang: AiLang): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const { ranking } = await this.mlbb.getHeroRanking({ limit: 400, lang });
      for (const r of ranking ?? []) {
        if (r?.name && typeof r.winRate === 'number') map.set(String(r.name).toLowerCase(), Math.round(r.winRate * 1000) / 10);
      }
    } catch (err) {
      this.logger.debug(`ranking unavailable: ${(err as Error).message}`);
    }
    return map;
  }

  private async llm<T>(tool: Parameters<typeof callStructured>[2], system: string, user: string, validate: (raw: any) => T | null): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await callStructured(this.client, this.model, tool, system, user);
      const out = raw ? validate(raw) : null;
      if (!out) this.logger.warn(`LLM ${tool}: invalid or empty structured output, falling back to heuristic.`);
      return out;
    } catch (err) {
      this.logger.error(`LLM ${tool} failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ----- endpoints ----------------------------------------------------------

  async coach(userId: string, lang: AiLang): Promise<CoachResponse> {
    return this.cachedOrLimited(userId, this.key('coach', { userId, lang, m: this.enabled }), async () => {
      const [player, catalog, wr] = await Promise.all([this.loadPlayer(userId), this.loadCatalog(), this.metaWinRates(lang)]);
      const fallback = coachHeuristic({ player, catalog, metaWinRateByName: wr, lang });
      const out = await this.llm(
        'coach',
        systemPrompt(lang, catalog),
        `PLAYER PROFILE\n${playerBlock(player)}\n\nGive a short summary, 3 to 5 actionable tips and up to 3 heroes to focus on (from the catalog, matching the main role and favourites when sensible).`,
        (raw) => validateCoach(raw, catalog),
      );
      return out ?? fallback;
    });
  }

  async recommendHeroes(userId: string, role: string | undefined, lane: string | undefined, lang: AiLang): Promise<HeroRecommendationsResponse> {
    const r = role?.toLowerCase() || null;
    const l = lane?.toLowerCase() || null;
    return this.cachedOrLimited(userId, this.key('recommend', { userId, r, l, lang, m: this.enabled }), async () => {
      const [player, catalog, wr] = await Promise.all([this.loadPlayer(userId), this.loadCatalog(), this.metaWinRates(lang)]);
      const fallback = recommendHeroesHeuristic({ player, catalog, role: r, lane: l, metaWinRateByName: wr, lang });
      const filtered = catalog.filter(
        (h) =>
          (!r || h.role.toLowerCase() === r || (h.roles ?? []).some((x) => x.toLowerCase() === r)) &&
          (!l || (h.laneKeys ?? []).some((x) => x.toLowerCase() === l)),
      );
      const pool = filtered.length ? filtered : catalog;
      const metaLines = [...wr.entries()].filter(([n]) => pool.some((h) => h.name.toLowerCase() === n)).slice(0, 60).map(([n, v]) => `${n}: ${v}% WR`).join(', ');
      const out = await this.llm(
        'recommend',
        systemPrompt(lang, pool),
        `PLAYER PROFILE\n${playerBlock(player)}\n\nFILTERS: role=${r ?? 'any'}, lane=${l ?? 'any'}\nMETA WIN RATES: ${metaLines || 'unavailable'}\n\nRecommend exactly 5 distinct heroes from the catalog above that fit the filters and the player.`,
        (raw) => validateRecommendations(raw, pool, { role: r, lane: l }),
      );
      return out ?? fallback;
    });
  }

  async recommendBuild(userId: string, heroId: string, lang: AiLang): Promise<BuildResponse> {
    const hero = await this.loadHero(heroId);
    return this.cachedOrLimited(userId, this.key('build', { heroId, lang, m: this.enabled }), async () => {
      const [catalog, meta] = await Promise.all([this.loadCatalog(), this.loadMeta(hero, lang)]);
      const fallback = buildHeuristic({ hero, meta, catalog, lang });
      const out = await this.llm(
        'build',
        systemPrompt(lang, catalog),
        `HERO: ${hero.name} [${hero.roles.join('/') || hero.role}; lanes: ${hero.laneKeys.join('/') || '?'}; speciality: ${hero.speciality.join(', ') || 'n/a'}]\nMETA\n${metaBlock(hero.name, meta)}\n\nPropose boots, 4 core items, up to 3 situational items, an emblem with 3 talents and a battle spell. Use only real current Mobile Legends equipment names. If meta statistics are unavailable, say so in the note.`,
        (raw) => validateBuild(raw, hero, fallback.metaAvailable),
      );
      return out ?? fallback;
    });
  }

  async counterPicks(userId: string, heroIds: string[], lang: AiLang): Promise<CounterResponse> {
    const ids = [...new Set(heroIds)];
    const enemies = await Promise.all(ids.map((id) => this.loadHero(id)));
    return this.cachedOrLimited(userId, this.key('counter', { ids: [...ids].sort(), lang, m: this.enabled }), async () => {
      const [catalog, wr, metas] = await Promise.all([
        this.loadCatalog(),
        this.metaWinRates(lang),
        Promise.all(enemies.map((e) => this.loadMeta(e, lang))),
      ]);
      const metaByEnemyId = new Map(enemies.map((e, i) => [e.id, metas[i]]));
      const fallback = counterPicksHeuristic({ enemies, metaByEnemyId, catalog, metaWinRateByName: wr, lang });
      const out = await this.llm(
        'counter',
        systemPrompt(lang, catalog),
        `ENEMY PICKS: ${enemies.map((e) => `${e.name} [${e.role}]`).join(', ')}\n\nMETA PER ENEMY\n${enemies.map((e) => metaBlock(e.name, metaByEnemyId.get(e.id) ?? null)).join('\n')}\n\nPropose up to 5 counter picks from the catalog (never the enemies themselves), each with the enemies it answers and an effectiveness between 0 and 1.`,
        (raw) => validateCounters(raw, catalog, enemies, fallback.metaAvailable),
      );
      return out ?? fallback;
    });
  }

  async analyze(userId: string, lang: AiLang): Promise<AnalysisResponse> {
    return this.cachedOrLimited(userId, this.key('analyze', { userId, lang, m: this.enabled }), async () => {
      const player = await this.loadPlayer(userId);
      const fallback = analysisHeuristic(player, lang);
      const { games, winRate } = winRateOf(player);
      const stats = { ...fallback.stats, games, winRate };
      const out = await this.llm(
        'analysis',
        systemPrompt(lang, []),
        `PLAYER PROFILE\n${playerBlock(player)}\n\nList the player's strengths and weaknesses (2 to 4 each, with impact) and 3 concrete recommendations. Base everything on the numbers above.`,
        (raw) => validateAnalysis(raw, stats),
      );
      return out ?? fallback;
    });
  }
}
