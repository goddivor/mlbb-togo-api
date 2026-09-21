import { Injectable } from '@nestjs/common';
import { MoontonClient, MoontonOutcome, MoontonResult } from './moonton.client';
import {
  CareerStats,
  FrequentHero,
  MatchDetail,
  MatchSummary,
  Page,
  mapCareerStats,
  mapFrequentHeroes,
  mapHeroMatches,
  mapMatchDetail,
  mapRecentMatches,
  mapSeasons,
} from './game.mappers';

export interface SourceResult<T> {
  outcome: MoontonOutcome;
  code: number | null;
  message: string | null;
  data: T | null;
}

/**
 * Provider of detailed game data (career stats, seasons, matches) for a
 * player session. The sync and the read API only depend on this interface:
 * when Moonton publishes replacement routes, plug a new implementation in
 * `game.module.ts` (token GAME_DATA_SOURCE) with its own mappers.
 */
export interface GameDataSource {
  readonly name: string;
  /**
   * False when the provider is known to be dead: the sync then never calls it
   * and relies on getBaseInfo only.
   */
  readonly available: boolean;
  careerStats(jwt: string): Promise<SourceResult<CareerStats & { seasons: number[] }>>;
  seasons(jwt: string): Promise<SourceResult<number[]>>;
  frequentHeroes(jwt: string, sid: number, cursor?: string | null, limit?: number): Promise<SourceResult<Page<FrequentHero>>>;
  recentMatches(jwt: string, sid: number, cursor?: string | null, limit?: number): Promise<SourceResult<Page<MatchSummary>>>;
  heroMatches(
    jwt: string,
    heroId: number,
    sid: number,
    cursor?: string | null,
    limit?: number,
  ): Promise<SourceResult<{ hero: FrequentHero | null } & Page<MatchSummary>>>;
  matchDetail(jwt: string, bid: string, sid: number, selfRoleId?: number | null): Promise<SourceResult<MatchDetail>>;
}

export const GAME_DATA_SOURCE = 'GAME_DATA_SOURCE';

function wrap<T>(r: MoontonResult, map: (d: any) => T): SourceResult<T> {
  return {
    outcome: r.outcome,
    code: r.code,
    message: r.message,
    data: r.ok ? map(r.data) : null,
  };
}

/**
 * The `battlereport/*` routes belonged to MLBB Academy, which Moonton shut
 * down for good on 30/06/2026: every route answers `10407` ("接口下线") and no
 * replacement web API exists (api-research/MOONTON_PLAYER.md). Kept false so
 * the sync never calls them; flip it only if Moonton brings them back.
 */
export const BATTLEREPORT_AVAILABLE = false;

/**
 * actgateway `battlereport/*` routes (headers and parameters documented in
 * api-research/ARENA_UPSTREAM.md). Decommissioned with MLBB Academy (see
 * BATTLEREPORT_AVAILABLE); kept as a reference implementation.
 */
@Injectable()
export class BattlereportSource implements GameDataSource {
  readonly name = 'battlereport';
  readonly available = BATTLEREPORT_AVAILABLE;

  constructor(private readonly client: MoontonClient) {}

  async careerStats(jwt: string) {
    const r = await this.client.actGet('battlereport/stats', {}, jwt);
    return wrap(r, (d) => ({ ...mapCareerStats(d), seasons: mapSeasons(d) }));
  }

  async seasons(jwt: string) {
    return wrap(await this.client.actGet('battlereport/season/list', {}, jwt), mapSeasons);
  }

  async frequentHeroes(jwt: string, sid: number, cursor?: string | null, limit = 20) {
    const r = await this.client.actGet('battlereport/heros/frequent', { sid, limit, last_cursor: cursor }, jwt);
    return wrap(r, mapFrequentHeroes);
  }

  async recentMatches(jwt: string, sid: number, cursor?: string | null, limit = 20) {
    const r = await this.client.actGet('battlereport/matches/recent', { sid, limit, last_cursor: cursor }, jwt);
    return wrap(r, (d) => mapRecentMatches(d, sid));
  }

  async heroMatches(jwt: string, heroId: number, sid: number, cursor?: string | null, limit = 20) {
    const r = await this.client.actGet(
      'battlereport/hero/matches',
      { hid: heroId, sid, limit, last_cursor: cursor },
      jwt,
    );
    return wrap(r, (d) => mapHeroMatches(d, sid));
  }

  async matchDetail(jwt: string, bid: string, sid: number, selfRoleId?: number | null) {
    const r = await this.client.actGet(`battlereport/matches/${encodeURIComponent(bid)}`, { sid }, jwt);
    return wrap(r, (d) => mapMatchDetail(d, selfRoleId));
  }
}
