// Pure mappers from Moonton battle report payloads (actgateway battlereport/*,
// field meanings in api-research/ARENA_API.md) to our storage/API shapes.
// Keep them free of I/O: a replacement upstream only needs new mappers.

export interface HeroRef {
  heroId: number;
  name: string;
  image: string | null;
  image2x: string | null;
}

export interface CareerRecord {
  value: number;
  heroId: number | null;
  heroName: string | null;
  heroImage: string | null;
  bid: string | null;
  playedAt: string | null;
}

export interface CareerStats {
  wins: number;
  total: number;
  losses: number;
  winRate: number;
  avgScore: number;
  gameTime: number;
  mvpCount: number;
  winStreak: number;
  records: Record<string, CareerRecord>;
}

export interface FrequentHero extends HeroRef {
  matches: number;
  wins: number;
  winRate: number;
  power: number;
  avgScore: number;
}

export interface MatchSummary {
  bid: string;
  sid: number;
  heroId: number;
  heroName: string | null;
  heroImage: string | null;
  kills: number;
  deaths: number;
  assists: number;
  laneId: number | null;
  score: number;
  mvp: boolean;
  win: boolean;
  playedAt: Date;
}

export interface MatchItem {
  id: number;
  name: string | null;
  image: string | null;
}

export interface MatchPlayer {
  team: number;
  name: string;
  isSelf: boolean;
  heroId: number;
  heroName: string | null;
  heroImage: string | null;
  heroLevel: number | null;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  teamfight: number;
  damage: number;
  damageShare: number;
  score: number;
  mvp: boolean;
  items: MatchItem[];
  win: boolean;
}

export interface MatchDetail {
  durationSec: number | null;
  playedAt: string | null;
  teams: Array<{ team: number; kills: number; win: boolean }>;
  players: MatchPlayer[];
}

export interface PageInfo {
  nextCursor: string | null;
  hasNext: boolean;
}

export interface Page<T> {
  items: T[];
  page: PageInfo;
}

const num = (v: any, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round = (v: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
export const pct = (wins: number, total: number) => (total ? round((wins / total) * 100) : 0);
/** Moonton scores are integers x100 (1180 = 11.8). */
export const score100 = (v: any) => round(num(v) / 100, 2);

/** Battle id: `bid_s` is exact, `bid` loses precision once JSON-parsed. */
export function bidOf(m: any): string | null {
  if (m?.bid_s != null && m.bid_s !== '') return String(m.bid_s);
  if (m?.bid != null) return String(m.bid);
  return null;
}

export function mapHeroRef(hid: any, e: any): HeroRef {
  const heroId = num(hid ?? e?.id);
  return {
    heroId,
    name: e?.n || `#${heroId}`,
    image: e?.ix || null,
    image2x: e?.i2x || null,
  };
}

function mapRecord(r: any): CareerRecord | null {
  if (!r || typeof r !== 'object') return null;
  return {
    value: num(r.v),
    heroId: r.hid != null ? num(r.hid) : null,
    heroName: r.hid_e?.n ?? null,
    heroImage: r.hid_e?.ix ?? null,
    bid: bidOf(r),
    playedAt: r.ts ? new Date(num(r.ts) * 1000).toISOString() : null,
  };
}

// Career records: Moonton key -> our key.
const RECORD_KEYS: Record<string, string> = {
  mo: 'mostDamage',
  hk: 'mostKills',
  ma: 'mostAssists',
  ms: 'bestScore',
  mdt: 'mostDamageTaken',
  mg: 'mostGold',
  mtd: 'mostTotalDamage',
};

/** `battlereport/stats` data -> career stats (keeps the legacy keys). */
export function mapCareerStats(d: any): CareerStats {
  const s = d || {};
  const wins = num(s.wc);
  const total = num(s.tc);
  const records: Record<string, CareerRecord> = {};
  for (const [key, out] of Object.entries(RECORD_KEYS)) {
    const r = mapRecord(s[key]);
    if (r) {
      // Scores are stored x100 like everywhere else.
      if (key === 'ms') r.value = score100(r.value);
      records[out] = r;
    }
  }
  return {
    wins,
    total,
    losses: Math.max(0, total - wins),
    winRate: pct(wins, total),
    avgScore: score100(s.as),
    gameTime: num(s.gt),
    mvpCount: num(s.mvpc),
    winStreak: num(s.wsc),
    records,
  };
}

/** `battlereport/season/list` (or stats) data -> season ids, newest first. */
export function mapSeasons(d: any): number[] {
  const sids = Array.isArray(d?.sids) ? d.sids : [];
  return [...new Set<number>(sids.map((x: any) => num(x, NaN)).filter((x: number) => Number.isFinite(x)))].sort(
    (a, b) => b - a,
  );
}

export function mapPageInfo(d: any): PageInfo {
  const p = d?.pageInfo || {};
  const cursor = p.nextCursor != null && p.nextCursor !== '' ? String(p.nextCursor) : null;
  return { nextCursor: cursor, hasNext: !!p.hasNext && !!cursor };
}

export function mapFrequentHero(h: any): FrequentHero {
  const matches = num(h?.tc);
  const wins = num(h?.wc);
  return {
    ...mapHeroRef(h?.hid, h?.hid_e),
    matches,
    wins,
    winRate: pct(wins, matches),
    power: num(h?.p),
    avgScore: score100(h?.bs),
  };
}

/** `battlereport/heros/frequent` data -> page of heroes. */
export function mapFrequentHeroes(d: any): Page<FrequentHero> {
  const rows = Array.isArray(d?.result) ? d.result : [];
  return { items: rows.map(mapFrequentHero), page: mapPageInfo(d) };
}

export function mapMatchSummary(m: any, fallbackSid?: number): MatchSummary | null {
  const bid = bidOf(m);
  if (!bid) return null;
  const hero = mapHeroRef(m.hid, m.hid_e);
  return {
    bid,
    sid: num(m.sid ?? fallbackSid),
    heroId: hero.heroId,
    heroName: m.hid_e?.n ?? null,
    heroImage: hero.image,
    kills: num(m.k),
    deaths: num(m.d),
    assists: num(m.a),
    laneId: m.lid != null ? num(m.lid) : null,
    score: score100(m.s),
    mvp: num(m.mvp) === 1 || m.mvp === true,
    win: num(m.res) === 1 || m.res === true,
    playedAt: new Date(num(m.ts) * 1000),
  };
}

/** `battlereport/matches/recent` data -> page of match summaries. */
export function mapRecentMatches(d: any, sid?: number): Page<MatchSummary> {
  const rows = Array.isArray(d?.result) ? d.result : [];
  return {
    items: rows.map((m: any) => mapMatchSummary(m, sid)).filter((m): m is MatchSummary => !!m),
    page: mapPageInfo(d),
  };
}

/** `battlereport/hero/matches` data -> hero record + page of matches. */
export function mapHeroMatches(d: any, sid?: number): { hero: FrequentHero | null } & Page<MatchSummary> {
  return {
    hero: d?.hi ? mapFrequentHero(d.hi) : null,
    ...mapRecentMatches(d, sid),
  };
}

export const kdaOf = (k: number, d: number, a: number) => round((k + a) / Math.max(1, d), 2);

/**
 * `battlereport/matches/{bid}` data -> 10-player scoreboard. Other players'
 * game ids (`rid`/`zid`) are dropped on purpose: only the owner is flagged.
 */
export function mapMatchDetail(d: any, selfRoleId?: number | null): MatchDetail {
  const rows: any[] = Array.isArray(d?.result) ? d.result : [];
  const players: MatchPlayer[] = rows.map((p) => {
    const hero = mapHeroRef(p.hid, p.hid_e);
    const itemsE: any[] = Array.isArray(p.its_e) ? p.its_e : [];
    const itemIds: any[] = Array.isArray(p.its) ? p.its : [];
    const items: MatchItem[] = itemIds
      .map((id, i) => ({ id: num(id), e: itemsE[i] }))
      .filter((x) => x.id > 0)
      .map((x) => ({ id: x.id, name: x.e?.n ?? null, image: x.e?.ix || null }));
    const k = num(p.k);
    const dd = num(p.d);
    const a = num(p.a);
    return {
      team: num(p.f),
      name: p.rname ? String(p.rname) : '?',
      isSelf: selfRoleId != null && num(p.rid) === selfRoleId,
      heroId: hero.heroId,
      heroName: p.hid_e?.n ?? null,
      heroImage: hero.image,
      heroLevel: p.hlvl != null ? num(p.hlvl) : null,
      kills: k,
      deaths: dd,
      assists: a,
      kda: kdaOf(k, dd, a),
      teamfight: round(num(p.tfr) * 100),
      damage: num(p.o),
      damageShare: round(num(p.op) * 100),
      score: score100(p.s),
      mvp: num(p.mvp) === 1 || p.mvp === true,
      items,
      win: num(p.fw) === 1 || p.fw === true,
    };
  });
  const first = rows[0];
  const teams = new Map<number, { team: number; kills: number; win: boolean }>();
  for (const p of rows) {
    const team = num(p.f);
    if (!teams.has(team)) teams.set(team, { team, kills: num(p.fk), win: num(p.fw) === 1 });
  }
  return {
    durationSec: first?.bd != null ? num(first.bd) : null,
    playedAt: first?.ts ? new Date(num(first.ts) * 1000).toISOString() : null,
    teams: [...teams.values()].sort((x, y) => x.team - y.team),
    players: players.sort((x, y) => x.team - y.team),
  };
}
