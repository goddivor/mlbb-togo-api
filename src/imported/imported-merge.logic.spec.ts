import { BadRequestException } from '@nestjs/common';
import {
  IMPORTED_EMAIL_DOMAIN,
  gamesWouldDuplicate,
  isAdoptedProfile,
  isImportedProfile,
  isPlaceholderEmail,
  matchPlayerConflicts,
  normalizeExpectedEmail,
  placeholderEmailFor,
  planTeamMemberships,
  retargetGames,
  retargetRegistry,
  retargetSeasonSummary,
  similarity,
  suggestTargets,
  mergeReasons,
  MIN_SUGGESTION_SCORE,
} from './imported-merge.logic';

describe('imported profile identity', () => {
  it('recognises placeholder mailboxes', () => {
    expect(isPlaceholderEmail(`kyle${IMPORTED_EMAIL_DOMAIN}`)).toBe(true);
    expect(isPlaceholderEmail(`KYLE${IMPORTED_EMAIL_DOMAIN.toUpperCase()}`)).toBe(true);
    expect(isPlaceholderEmail('kyle@gmail.com')).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
  });

  it('rebuilds the placeholder mailbox from the username', () => {
    expect(placeholderEmailFor('Kyle-Ghost')).toBe(`kyle-ghost${IMPORTED_EMAIL_DOMAIN}`);
  });

  it('only treats non-system imported accounts as profiles', () => {
    const base = { id: 'a', username: 'kyle', email: `kyle${IMPORTED_EMAIL_DOMAIN}` };
    expect(isImportedProfile({ ...base, provider: 'imported' })).toBe(true);
    expect(isImportedProfile({ ...base, provider: 'imported', isSystemAccount: true })).toBe(false);
    expect(isImportedProfile({ ...base, provider: 'google' })).toBe(false);
    expect(isImportedProfile(null)).toBe(false);
  });

  it('detects an adopted profile by Google id or real mailbox', () => {
    const placeholder = { id: 'a', username: 'kyle', email: `kyle${IMPORTED_EMAIL_DOMAIN}` };
    expect(isAdoptedProfile(placeholder)).toBe(false);
    expect(isAdoptedProfile({ ...placeholder, googleId: 'g1' })).toBe(true);
    expect(isAdoptedProfile({ ...placeholder, email: 'kyle@gmail.com' })).toBe(true);
  });
});

describe('normalizeExpectedEmail', () => {
  it('lowercases and trims a valid address', () => {
    expect(normalizeExpectedEmail('  Kyle.Ghost@Gmail.COM ')).toBe('kyle.ghost@gmail.com');
  });

  it('treats empty and null as "clear"', () => {
    expect(normalizeExpectedEmail('')).toBeNull();
    expect(normalizeExpectedEmail('   ')).toBeNull();
    expect(normalizeExpectedEmail(null)).toBeNull();
    expect(normalizeExpectedEmail(undefined)).toBeNull();
  });

  it('refuses malformed addresses and the reserved domain', () => {
    expect(() => normalizeExpectedEmail('kyle')).toThrow(BadRequestException);
    expect(() => normalizeExpectedEmail('kyle@local')).toThrow(BadRequestException);
    expect(() => normalizeExpectedEmail(42)).toThrow(BadRequestException);
    expect(() => normalizeExpectedEmail(`kyle${IMPORTED_EMAIL_DOMAIN}`)).toThrow(
      BadRequestException,
    );
  });
});

describe('similarity and suggestions', () => {
  it('scores identical, contained and distant names', () => {
    expect(similarity('Kyle_Ghost', 'kyle ghost')).toBe(1);
    expect(similarity('kyleghost', 'kyleghost228')).toBeGreaterThan(0.6);
    expect(similarity('kyle', 'zenith')).toBeLessThan(0.3);
    expect(similarity('', 'kyle')).toBe(0);
  });

  it('ranks the best candidates and says which field matched', () => {
    const profile = { username: 'kyle-ghost', gameNickname: 'Kyle_Ghost' };
    const out = suggestTargets(profile, [
      { id: 'u1', username: 'randomguy', gameNickname: null },
      { id: 'u2', username: 'kyleghost', gameNickname: 'Something' },
      { id: 'u3', username: 'player3', gameNickname: 'Kyle Ghost' },
    ]);
    expect(out.map((o) => o.id)).toEqual(['u2', 'u3']);
    expect(out[0].score).toBe(1);
    expect(out[0].matchedOn).toBe('username');
    expect(out[1].matchedOn).toBe('gameNickname');
  });

  it('honours the limit and the minimum score', () => {
    const profile = { username: 'kyle', gameNickname: null };
    const rows = [
      { id: 'a', username: 'kyle' },
      { id: 'b', username: 'kylo' },
      { id: 'c', username: 'kyle' },
    ];
    expect(suggestTargets(profile, rows, 1)).toHaveLength(1);
    expect(suggestTargets(profile, rows, 10, 0.99).map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('planTeamMemberships', () => {
  it('moves the rows the target does not already have', () => {
    const plan = planTeamMemberships(
      [
        { id: 'm1', teamId: 't1' },
        { id: 'm2', teamId: 't2' },
      ],
      ['t2'],
    );
    expect(plan).toEqual({ move: ['m1'], drop: ['m2'] });
  });

  it('never moves two rows onto the same team', () => {
    const plan = planTeamMemberships(
      [
        { id: 'm1', teamId: 't1' },
        { id: 'm2', teamId: 't1' },
      ],
      [],
    );
    expect(plan).toEqual({ move: ['m1'], drop: ['m2'] });
  });

  it('is empty when there is nothing to move', () => {
    expect(planTeamMemberships([], ['t1'])).toEqual({ move: [], drop: [] });
  });
});

describe('matchPlayerConflicts', () => {
  it('lists the matches both accounts already played', () => {
    expect(
      matchPlayerConflicts(
        [
          { id: 'p1', matchId: 'x' },
          { id: 'p2', matchId: 'y' },
          { id: 'p3', matchId: 'y' },
        ],
        ['y', 'z'],
      ),
    ).toEqual(['y']);
  });

  it('returns nothing when the target played none of them', () => {
    expect(matchPlayerConflicts([{ id: 'p1', matchId: 'x' }], ['y'])).toEqual([]);
  });
});

describe('retargetGames', () => {
  const games = JSON.stringify([
    {
      number: 1,
      winnerTeamId: 'tA',
      mvpUserId: 'src',
      picks: [
        { userId: 'src', teamId: 'tA', heroId: 'h1', hero: 'Lancelot', isSub: false },
        { userId: 'other', teamId: 'tB', heroId: 'h2', hero: 'Chou', isSub: false },
      ],
    },
    { number: 2, winnerTeamId: 'tB', mvpUserId: null, picks: [{ userId: 'src', teamId: 'tA' }] },
  ]);

  it('rewrites picks and per-game MVP, keeping every other field', () => {
    const out = retargetGames(games, 'src', 'dst');
    expect(out.changed).toBe(3);
    const parsed = JSON.parse(out.value!);
    expect(parsed[0].mvpUserId).toBe('dst');
    expect(parsed[0].picks[0].userId).toBe('dst');
    expect(parsed[0].picks[0].hero).toBe('Lancelot');
    expect(parsed[0].picks[1].userId).toBe('other');
    expect(parsed[0].winnerTeamId).toBe('tA');
    expect(parsed[1].picks[0].userId).toBe('dst');
  });

  it('leaves untouched documents alone', () => {
    expect(retargetGames(games, 'nobody', 'dst')).toEqual({ value: games, changed: 0 });
    expect(retargetGames(null, 'src', 'dst')).toEqual({ value: null, changed: 0 });
    expect(retargetGames('{oops', 'src', 'dst')).toEqual({ value: '{oops', changed: 0 });
    expect(retargetGames('{"a":1}', 'src', 'dst')).toEqual({ value: '{"a":1}', changed: 0 });
  });

  it('is idempotent', () => {
    const once = retargetGames(games, 'src', 'dst');
    expect(retargetGames(once.value, 'src', 'dst').changed).toBe(0);
  });

  it('detects a game listing both accounts', () => {
    const both = JSON.stringify([{ picks: [{ userId: 'src' }, { userId: 'dst' }] }]);
    expect(gamesWouldDuplicate(both, 'src', 'dst')).toBe(true);
    expect(gamesWouldDuplicate(games, 'src', 'dst')).toBe(false);
    expect(gamesWouldDuplicate(null, 'src', 'dst')).toBe(false);
    expect(gamesWouldDuplicate('nope', 'src', 'dst')).toBe(false);
  });
});

describe('retargetRegistry', () => {
  const registry = JSON.stringify({
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    players: { '11': 'src', '12': 'src', '13': 'other' },
    teamMembers: { '1:11': 'mem-gone', '1:12': 'mem-kept' },
    matches: { '1': 'm1' },
    seasons: {},
  });

  it('repoints every legacy id of the profile and keeps the rest', () => {
    const out = retargetRegistry(registry, 'src', 'dst');
    expect(out.legacyIds).toEqual(['11', '12']);
    const parsed = JSON.parse(out.value!);
    expect(parsed.players).toEqual({ '11': 'dst', '12': 'dst', '13': 'other' });
    expect(parsed.matches).toEqual({ '1': 'm1' });
    expect(parsed.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.version).toBe(1);
  });

  it('prunes the entries of the rows the merge deletes, in any map', () => {
    const out = retargetRegistry(registry, 'src', 'dst', ['mem-gone']);
    expect(out.pruned).toBe(1);
    const parsed = JSON.parse(out.value!);
    expect(parsed.teamMembers).toEqual({ '1:12': 'mem-kept' });
  });

  it('writes when only a prune is needed', () => {
    const out = retargetRegistry(registry, 'nobody', 'dst', ['mem-gone']);
    expect(out.legacyIds).toEqual([]);
    expect(out.pruned).toBe(1);
    expect(out.value).not.toBeNull();
  });

  it('reports no change when the profile is absent or the value unusable', () => {
    expect(retargetRegistry(registry, 'nobody', 'dst')).toEqual({
      value: null,
      legacyIds: [],
      pruned: 0,
    });
    expect(retargetRegistry(null, 'src', 'dst').value).toBeNull();
    expect(retargetRegistry('{broken', 'src', 'dst').value).toBeNull();
    expect(retargetRegistry('[]', 'src', 'dst').value).toBeNull();
    expect(retargetRegistry('{"players":[]}', 'src', 'dst').value).toBeNull();
  });

  it('is idempotent', () => {
    const once = retargetRegistry(registry, 'src', 'dst');
    expect(retargetRegistry(once.value, 'src', 'dst').legacyIds).toEqual([]);
  });
});

describe('retargetSeasonSummary', () => {
  const summary = JSON.stringify({
    standings: [{ teamId: 'tA', points: 9 }],
    legacy: {
      rosters: [
        { teamId: 'tA', userId: 'src', role: 'jungle' },
        { teamId: 'tB', userId: 'other', role: 'mid' },
      ],
      bracket: [{ round: 1, order: 1 }],
    },
  });

  it('repoints the archived roster and keeps everything else', () => {
    const out = retargetSeasonSummary(summary, 'src', 'dst');
    expect(out).toMatchObject({ changed: 1, dropped: 0 });
    const parsed = JSON.parse(out.value!);
    expect(parsed.legacy.rosters).toEqual([
      { teamId: 'tA', userId: 'dst', role: 'jungle' },
      { teamId: 'tB', userId: 'other', role: 'mid' },
    ]);
    expect(parsed.standings).toEqual([{ teamId: 'tA', points: 9 }]);
    expect(parsed.legacy.bracket).toEqual([{ round: 1, order: 1 }]);
  });

  it('drops the line instead of listing the target twice on one team', () => {
    const both = JSON.stringify({
      legacy: {
        rosters: [
          { teamId: 'tA', userId: 'src', role: 'jungle' },
          { teamId: 'tA', userId: 'dst', role: 'jungle' },
        ],
      },
    });
    const out = retargetSeasonSummary(both, 'src', 'dst');
    expect(out).toMatchObject({ changed: 0, dropped: 1 });
    expect(JSON.parse(out.value!).legacy.rosters).toEqual([
      { teamId: 'tA', userId: 'dst', role: 'jungle' },
    ]);
  });

  it('ignores summaries without a legacy archive and unusable values', () => {
    expect(retargetSeasonSummary('{"standings":[]}', 'src', 'dst').value).toBeNull();
    expect(retargetSeasonSummary(null, 'src', 'dst').value).toBeNull();
    expect(retargetSeasonSummary('{oops', 'src', 'dst').value).toBeNull();
    expect(retargetSeasonSummary(summary, 'nobody', 'dst').value).toBeNull();
  });

  it('is idempotent', () => {
    const once = retargetSeasonSummary(summary, 'src', 'dst');
    expect(retargetSeasonSummary(once.value, 'src', 'dst').value).toBeNull();
  });
});

describe('mergeReasons', () => {
  it('returns translatable codes, never sentences', () => {
    expect(mergeReasons(['m1', 'm2'], ['g1'], [{ model: 'post', count: 3 }])).toEqual([
      { code: 'match_conflict', count: 2 },
      { code: 'game_duplicate', count: 1 },
      { code: 'blocking', model: 'post', count: 3 },
    ]);
    expect(mergeReasons([], [], [])).toEqual([]);
  });
});

describe('suggestion floor', () => {
  it('keeps noise out by default', () => {
    const rows = [{ id: 'far', username: 'zenithpro' }];
    expect(similarity('kyle', 'zenithpro')).toBeLessThan(MIN_SUGGESTION_SCORE);
    expect(suggestTargets({ username: 'kyle', gameNickname: null }, rows)).toEqual([]);
  });
});
