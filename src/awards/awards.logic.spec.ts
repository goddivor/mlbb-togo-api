import {
  compareAwards,
  derivePlayoffsPodium,
  derivePodiumFromBracket,
  normalizePodium,
  parsePodiums,
  serializeAward,
  suggestAwards,
} from './awards.logic';
import type { BracketMatch } from '../tournaments/bracket.util';

const T1 = 'a1a1a1a1a1a1a1a1a1a1a1a1';
const T2 = 'b2b2b2b2b2b2b2b2b2b2b2b2';
const T3 = 'c3c3c3c3c3c3c3c3c3c3c3c3';
const T4 = 'd4d4d4d4d4d4d4d4d4d4d4d4';

let seq = 0;
const match = (
  teamAId: string,
  teamBId: string,
  scoreA: number,
  scoreB: number,
  over: Partial<{ stage: string | null; type: string; scheduledAt: string; status: string }> = {},
) => ({
  id: `m${++seq}`,
  seasonId: 's',
  type: over.type ?? 'official',
  stage: over.stage === undefined ? 'playoff' : over.stage,
  status: over.status ?? 'completed',
  teamAId,
  teamBId,
  scoreA,
  scoreB,
  winnerTeamId: scoreA === scoreB ? null : scoreA > scoreB ? teamAId : teamBId,
  scheduledAt: over.scheduledAt ?? `2026-03-${String(10 + seq).padStart(2, '0')}T18:00:00Z`,
});

const player = (matchId: string, userId: string, teamId: string, role: string, k: number, d: number, a: number, isMvp = false) => ({
  matchId,
  userId,
  teamId,
  role,
  kills: k,
  deaths: d,
  assists: a,
  isMvp,
  hero: 'Layla',
});

describe('suggestAwards', () => {
  const m1 = { ...match(T1, T2, 2, 0, { stage: 'league' }) };
  const m2 = { ...match(T1, T2, 2, 1, { stage: 'league' }) };
  const m3 = { ...match(T2, T1, 2, 0, { stage: 'league' }) };
  const matches = [m1, m2, m3];
  const players = [
    // u1: gold laner, 3 games, 2 MVPs, strong KDA.
    player(m1.id, 'u1', T1, 'gold', 10, 2, 5, true),
    player(m2.id, 'u1', T1, 'gold', 8, 1, 6, true),
    player(m3.id, 'u1', T1, 'gold', 3, 5, 2),
    // u2: mid laner of T2, 3 games, 1 MVP, better raw KDA.
    player(m1.id, 'u2', T2, 'mid', 4, 1, 12),
    player(m2.id, 'u2', T2, 'mid', 6, 1, 10),
    player(m3.id, 'u2', T2, 'mid', 9, 0, 8, true),
    // u3: jungler with a single game (below the default threshold).
    player(m1.id, 'u3', T1, 'jungle', 20, 0, 0),
  ];

  it('picks the MVP by match MVP count and lane winners by KDA', () => {
    const out = suggestAwards(matches, players);
    const by = Object.fromEntries(out.map((s) => [s.category, s]));
    expect(by.mvp.userId).toBe('u1');
    expect(by.mvp.criteria.mvpCount).toBe(2);
    expect(by.mvp.criteria.basis).toBe('mvp');
    expect(by.best_gold.userId).toBe('u1');
    expect(by.best_mid.userId).toBe('u2');
    expect(by.best_mid.criteria.basis).toBe('kda');
    expect(by.best_mid.criteria.games).toBe(3);
    expect(by.best_exp).toBeUndefined();
    expect(by.best_roam).toBeUndefined();
  });

  it('relaxes the games threshold to 1 when nobody qualifies on a lane', () => {
    const out = suggestAwards(matches, players);
    const jungle = out.find((s) => s.category === 'best_jungle')!;
    expect(jungle.userId).toBe('u3');
    expect(jungle.criteria.minGames).toBe(1);
    const mvp = out.find((s) => s.category === 'mvp')!;
    expect(mvp.criteria.minGames).toBe(3);
  });

  it('lists runner-ups and returns nothing without stats', () => {
    const out = suggestAwards(matches, players, { alternatives: 5 });
    const mvp = out.find((s) => s.category === 'mvp')!;
    // u3 has a single game: below the 3-game threshold the MVP race still honours.
    expect(mvp.alternatives.map((a) => a.userId)).toEqual(['u2']);
    expect(suggestAwards(matches, [])).toEqual([]);
  });
});

describe('derivePlayoffsPodium', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('reads the final and ranks the most recently eliminated team third', () => {
    const semi1 = match(T1, T3, 2, 0, { scheduledAt: '2026-04-01T18:00:00Z' });
    const semi2 = match(T2, T4, 2, 1, { scheduledAt: '2026-04-02T18:00:00Z' });
    const final = match(T1, T2, 3, 1, { scheduledAt: '2026-04-05T18:00:00Z' });
    const podium = derivePlayoffsPodium([final, semi1, semi2]);
    expect(podium).toEqual([
      { placement: 1, teamId: T1 },
      { placement: 2, teamId: T2 },
      { placement: 3, teamId: T4 },
    ]);
  });

  it('uses the third-place match when both teams were already eliminated', () => {
    const semi1 = match(T1, T3, 2, 0, { scheduledAt: '2026-04-01T18:00:00Z' });
    const semi2 = match(T2, T4, 2, 1, { scheduledAt: '2026-04-02T18:00:00Z' });
    const third = match(T3, T4, 2, 1, { scheduledAt: '2026-04-05T16:00:00Z' });
    const final = match(T1, T2, 3, 1, { scheduledAt: '2026-04-05T20:00:00Z' });
    expect(derivePlayoffsPodium([semi1, semi2, third, final])?.map((p) => p.teamId)).toEqual([T1, T2, T3]);
    // A third-place match played after the final still does not become the final.
    const lateThird = match(T3, T4, 2, 1, { scheduledAt: '2026-04-06T20:00:00Z' });
    expect(derivePlayoffsPodium([semi1, semi2, final, lateThird])?.map((p) => p.teamId)).toEqual([T1, T2, T3]);
  });

  it('ignores league games, drawn and pending matches, and honours the stage / date rules', () => {
    const league = match(T1, T2, 2, 0, { stage: 'league', scheduledAt: '2026-04-09T18:00:00Z' });
    const pending = match(T3, T4, 0, 0, { status: 'scheduled', scheduledAt: '2026-04-10T18:00:00Z' });
    expect(derivePlayoffsPodium([league, pending])).toBeNull();
    const legacyPlayoff = match(T3, T4, 2, 0, { stage: null, type: 'playoff' });
    expect(derivePlayoffsPodium([legacyPlayoff])?.map((p) => p.teamId)).toEqual([T3, T4]);
    // Legacy league game after the playoffs kick-off.
    const late = match(T1, T2, 2, 0, { stage: null, type: 'official', scheduledAt: '2026-05-01T18:00:00Z' });
    expect(derivePlayoffsPodium([late], { playoffsStartDate: '2026-04-20' })?.map((p) => p.teamId)).toEqual([T1, T2]);
    expect(derivePlayoffsPodium([late], { playoffsStartDate: '2026-06-20' })).toBeNull();
  });
});

describe('derivePodiumFromBracket', () => {
  const bm = (id: string, round: number, position: number, a: string | null, b: string | null, sa: number, sb: number, status: BracketMatch['status'] = 'finished'): BracketMatch => ({
    id,
    round,
    position,
    teamAId: a,
    teamBId: b,
    scoreA: sa,
    scoreB: sb,
    winnerTeamId: status === 'finished' ? (sa > sb ? a : b) : null,
    status,
    scheduledAt: null,
    streamUrl: null,
  });

  it('returns null until the final is finished, then 1-2 from the final and 3 from the semis', () => {
    const semis = [bm('r1-0', 1, 0, T1, T3, 2, 1), bm('r1-1', 1, 1, T2, T4, 2, 0)];
    expect(derivePodiumFromBracket([...semis, bm('r2-0', 2, 0, T1, T2, 0, 0, 'scheduled')])).toBeNull();
    expect(derivePodiumFromBracket([...semis, bm('r2-0', 2, 0, T1, T2, 1, 3)])).toEqual([
      { placement: 1, teamId: T2 },
      { placement: 2, teamId: T1 },
      { placement: 3, teamId: T3 },
    ]);
    expect(derivePodiumFromBracket([])).toBeNull();
  });
});

describe('podium helpers', () => {
  it('normalizes placements, drops duplicates and sorts', () => {
    expect(
      normalizePodium([
        { placement: 3, teamId: T3 },
        { placement: '1', teamId: T1 },
        { placement: 1, teamId: T2 },
        { placement: 2, teamId: T1 },
        { placement: 4, teamId: T4 },
      ]),
    ).toEqual([
      { placement: 1, teamId: T1 },
      { placement: 3, teamId: T3 },
    ]);
    expect(normalizePodium([])).toBeNull();
    expect(normalizePodium('nope')).toBeNull();
  });

  it('parses the stored JSON defensively', () => {
    expect(parsePodiums(null)).toEqual({ regular: null, playoffs: null });
    expect(parsePodiums('{oops')).toEqual({ regular: null, playoffs: null });
    expect(parsePodiums(JSON.stringify({ playoffs: [{ placement: 1, teamId: T1 }] }))).toEqual({
      regular: null,
      playoffs: [{ placement: 1, teamId: T1 }],
    });
  });
});

describe('awards serialization', () => {
  it('orders MVP first, then lanes, then customs by sort', () => {
    const rows = [
      { id: '1', seasonId: 's', category: 'custom', sort: 2, title: 'B' },
      { id: '2', seasonId: 's', category: 'best_mid' },
      { id: '3', seasonId: 's', category: 'mvp' },
      { id: '4', seasonId: 's', category: 'custom', sort: 1, title: 'A' },
      { id: '5', seasonId: 's', category: 'best_gold' },
    ];
    expect([...rows].sort(compareAwards).map((r) => r.id)).toEqual(['3', '5', '2', '4', '1']);
  });

  it('resolves user / team refs and parses criteria', () => {
    const users = new Map([['u1', { id: 'u1', username: 'neo', displayName: 'Neo', avatar: null }]]);
    const teams = new Map([[T1, { id: T1, name: 'Alpha', image: null }]]);
    const out = serializeAward(
      { id: 'a', seasonId: 's', category: 'best_gold', userId: 'u1', teamId: T1, criteria: '{"kda":4.5}' },
      users,
      teams,
    );
    expect(out.lane).toBe('gold');
    expect(out.user?.displayName).toBe('Neo');
    expect(out.team?.name).toBe('Alpha');
    expect(out.criteria).toEqual({ kda: 4.5 });
    const unknown = serializeAward({ id: 'b', seasonId: 's', category: 'mvp', userId: 'zz', criteria: '{bad' }, users, teams);
    expect(unknown.user?.username).toBe('?');
    expect(unknown.criteria).toBeNull();
  });
});
