import { MatchLike, TeamRef } from '../esport/esport-stats.service';
import {
  DEFAULT_SETTINGS,
  computeStandings,
  enrichFrozenRows,
  h2hBalance,
  headToHead,
  isPlayoffMatch,
  matchesUntil,
  mergeSettings,
  parseSettings,
  scopeMatches,
  strengthOfSchedule,
} from './standings.logic';
import { StandingsService } from './standings.service';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';
const D = 'dddddddddddddddddddddddd';

const teams = new Map<string, TeamRef>([
  [A, { id: A, name: 'Alpha', image: null }],
  [B, { id: B, name: 'Beta', image: null }],
  [C, { id: C, name: 'Gamma', image: null }],
  [D, { id: D, name: 'Delta', image: null }],
]);

let seq = 0;
const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const match = (
  teamAId: string,
  teamBId: string,
  a: number,
  b: number,
  over: Partial<MatchLike> = {},
): MatchLike => ({
  id: `m${++seq}`,
  status: 'completed',
  type: 'official',
  seasonId: 's',
  teamAId,
  teamBId,
  scoreA: a,
  scoreB: b,
  winnerTeamId: a > b ? teamAId : b > a ? teamBId : null,
  scheduledAt: day(seq),
  ...over,
});

describe('settings', () => {
  it('falls back to the defaults on junk input', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"qualifyTop":5}').qualifyTop).toBe(4);
  });

  it('parses and merges valid values', () => {
    const s = parseSettings(JSON.stringify({ points: { win: 2 }, qualifyTop: 6 }));
    expect(s).toEqual({ points: { win: 2, draw: 1, loss: 0 }, qualifyTop: 6 });
    expect(mergeSettings(s, { qualifyTop: 8, points: { loss: 1 } })).toEqual({
      points: { win: 2, draw: 1, loss: 1 },
      qualifyTop: 8,
    });
  });

  it('validates the standings type', () => {
    expect(StandingsService.parseType(undefined)).toBe('league');
    expect(StandingsService.parseType('ALL')).toBe('all');
    expect(() => StandingsService.parseType('nope')).toThrow();
    expect(StandingsService.parseLang('de')).toBe('fr');
    expect(StandingsService.parseLang('en')).toBe('en');
  });
});

describe('scopeMatches', () => {
  const season = { playoffsStartDate: day(10) };
  const list = [
    match(A, B, 2, 0, { type: 'friendly', scheduledAt: day(1) }),
    match(A, B, 2, 0, { type: 'official', scheduledAt: day(2) }),
    match(A, B, 2, 1, { type: 'official', scheduledAt: day(12) }),
    match(A, B, 2, 1, { type: 'playoff', scheduledAt: day(3) }),
    match(A, B, 0, 0, { status: 'scheduled' }),
  ];

  it('keeps league matches played before the playoffs', () => {
    expect(scopeMatches(list, 'league', season).map((m) => m.id)).toEqual([list[1].id]);
  });

  it('treats explicit playoff types and post-kick-off league games as playoffs', () => {
    expect(isPlayoffMatch(list[2], season)).toBe(true);
    expect(isPlayoffMatch(list[2], null)).toBe(false);
    expect(scopeMatches(list, 'playoff', season).map((m) => m.id)).toEqual([list[2].id, list[3].id]);
  });

  it('all = every completed match, whatever its type', () => {
    expect(scopeMatches(list, 'all', season)).toHaveLength(4);
  });

  it('matchesUntil ignores undated matches', () => {
    const undated = match(A, B, 1, 0, { scheduledAt: null, createdAt: null });
    expect(matchesUntil([list[1], list[2], undated], day(5)).map((m) => m.id)).toEqual([list[1].id]);
  });
});

describe('computeStandings', () => {
  it('scores 3 / 1 / 0 by default and applies the tie-breakers in order', () => {
    // Alpha and Beta both 2 wins; Beta has the better diff. Gamma / Delta on 0.
    const list = [
      match(A, C, 2, 0),
      match(A, D, 2, 1),
      match(B, C, 2, 0),
      match(B, D, 2, 0),
      match(C, D, 1, 1),
    ];
    const rows = computeStandings(list, DEFAULT_SETTINGS, teams);
    expect(rows.map((r) => r.team.name)).toEqual(['Beta', 'Alpha', 'Delta', 'Gamma']);
    expect(rows[0].points).toBe(6);
    expect(rows[0].scoreDiff).toBe(4);
    expect(rows[1].scoreDiff).toBe(3);
    // Delta and Gamma: same points (1), same diff? Delta -1, Gamma -3 -> Delta first.
    expect(rows[2].points).toBe(1);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('breaks a full tie with head-to-head, then by name', () => {
    // A beat B directly; both have 1 win / 1 loss, same diff, same WR.
    const list = [match(A, B, 1, 0), match(C, A, 1, 0), match(B, C, 1, 0)];
    const rows = computeStandings(list, DEFAULT_SETTINGS, teams);
    // Three-way circle: every pair is decided by H2H, sort stays stable and ranked.
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.points))).toEqual(new Set([3]));
    expect(h2hBalance(A, B, list)).toBe(1);
    expect(h2hBalance(B, A, list)).toBe(-1);

    // Pure name tie: no match between them.
    const tie = [match(A, C, 1, 0), match(B, D, 1, 0)];
    expect(computeStandings(tie, DEFAULT_SETTINGS, teams).map((r) => r.team.name)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Gamma',
    ]);
  });

  it('exposes streak, form, qualification and SoS', () => {
    const list = [match(A, B, 1, 0), match(A, C, 1, 0), match(A, D, 0, 1), match(A, B, 1, 0), match(A, C, 1, 0), match(A, D, 1, 0)];
    const rows = computeStandings(list, { ...DEFAULT_SETTINGS, qualifyTop: 2 }, teams);
    const alpha = rows.find((r) => r.teamId === A)!;
    expect(alpha.rank).toBe(1);
    expect(alpha.form).toEqual(['W', 'L', 'W', 'W', 'W']);
    expect(alpha.streak).toEqual({ type: 'W', count: 3 });
    expect(alpha.qualified).toBe(true);
    expect(rows.filter((r) => r.qualified)).toHaveLength(2);
    // Opponents: B (0%), C (0%), D (50%) faced twice each -> (0+0+50+0+0+50)/6.
    expect(alpha.sos).toBe(17);
    const delta = rows.find((r) => r.teamId === D)!;
    // Delta faced Alpha (WR 83) twice.
    expect(delta.sos).toBe(83);
  });

  it('computes 7 / 30 day rank deltas from snapshots of the table', () => {
    const asOf = day(31);
    const list = [
      match(A, B, 1, 0, { scheduledAt: day(1) }), // A leads early
      match(A, C, 1, 0, { scheduledAt: day(2) }),
      match(B, C, 1, 0, { scheduledAt: day(3) }),
      match(B, A, 1, 0, { scheduledAt: day(26) }), // B catches up in the last week
      match(B, C, 1, 0, { scheduledAt: day(30) }),
    ];
    const rows = computeStandings(list, DEFAULT_SETTINGS, teams, asOf);
    const beta = rows.find((r) => r.teamId === B)!;
    const alpha = rows.find((r) => r.teamId === A)!;
    expect(beta.rank).toBe(1);
    expect(beta.delta.d7).toBe(1); // was 2nd on day 24
    expect(alpha.delta.d7).toBe(-1);
    // 30 days ago (day 1, inclusive): only A vs B played -> A 1st, B 2nd, C unranked.
    expect(beta.delta.d30).toBe(1);
    expect(alpha.delta.d30).toBe(-1);
    expect(rows.find((r) => r.teamId === C)!.delta.d30).toBeNull();
  });

  it('strengthOfSchedule returns null without games', () => {
    expect(strengthOfSchedule([], new Map())).toBeNull();
  });
});

describe('frozen standings', () => {
  it('re-ranks the snapshot with the module tie-breakers and adds live extras', () => {
    const list = [match(A, B, 2, 0), match(A, B, 0, 2), match(A, B, 2, 1)];
    const computed = computeStandings(list, DEFAULT_SETTINGS, teams);
    const frozen = [
      { rank: 1, teamId: B, team: teams.get(B)!, played: 3, wins: 1, losses: 2, draws: 0, winRate: 33, scoreFor: 3, scoreAgainst: 4, scoreDiff: -1 },
      { rank: 2, teamId: A, team: teams.get(A)!, played: 3, wins: 2, losses: 1, draws: 0, winRate: 67, scoreFor: 4, scoreAgainst: 3, scoreDiff: 1 },
    ];
    const rows = enrichFrozenRows(frozen, computed, { ...DEFAULT_SETTINGS, qualifyTop: 1 }, list);

    // The snapshot listed B first (it was ordered on wins); points rule first.
    expect(rows.map((r) => r.teamId)).toEqual([A, B]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows.map((r) => r.snapshotRank)).toEqual([2, 1]);
    expect(rows[0].points).toBe(6);
    expect(rows[1].points).toBe(3);
    expect(rows[0].streak).toEqual({ type: 'W', count: 1 });
    expect(rows[0].qualified).toBe(true);
    expect(rows[1].qualified).toBe(false);

    // Records still come from the snapshot, not from a recomputation.
    expect(rows[0].wins).toBe(2);
    expect(rows[1].wins).toBe(1);
  });
});

describe('headToHead', () => {
  it('returns the record from the point of view of teamA, oldest first', () => {
    const list = [match(A, B, 2, 0, { scheduledAt: day(5) }), match(B, A, 2, 1, { scheduledAt: day(1) }), match(A, C, 1, 0)];
    const rec = headToHead(teams.get(A)!, teams.get(B)!, list);
    expect(rec.played).toBe(2);
    expect(rec.winsA).toBe(1);
    expect(rec.winsB).toBe(1);
    expect(rec.scoreA).toBe(3);
    expect(rec.scoreB).toBe(2);
    expect(rec.matches[0].date).toEqual(day(1));
    expect(rec.matches[0].scoreA).toBe(1); // A was teamB on that match
    expect(rec.last?.date).toEqual(day(5));
  });
});
