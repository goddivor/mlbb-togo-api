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
  retargetRegistryPlayers,
  similarity,
  suggestTargets,
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

describe('retargetRegistryPlayers', () => {
  const registry = JSON.stringify({
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    players: { '11': 'src', '12': 'src', '13': 'other' },
    matches: { '1': 'm1' },
    seasons: {},
  });

  it('repoints every legacy id of the profile and keeps the rest', () => {
    const out = retargetRegistryPlayers(registry, 'src', 'dst');
    expect(out.legacyIds).toEqual(['11', '12']);
    const parsed = JSON.parse(out.value!);
    expect(parsed.players).toEqual({ '11': 'dst', '12': 'dst', '13': 'other' });
    expect(parsed.matches).toEqual({ '1': 'm1' });
    expect(parsed.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.version).toBe(1);
  });

  it('reports no change when the profile is absent or the value unusable', () => {
    expect(retargetRegistryPlayers(registry, 'nobody', 'dst')).toEqual({
      value: null,
      legacyIds: [],
    });
    expect(retargetRegistryPlayers(null, 'src', 'dst')).toEqual({ value: null, legacyIds: [] });
    expect(retargetRegistryPlayers('{broken', 'src', 'dst')).toEqual({
      value: null,
      legacyIds: [],
    });
    expect(retargetRegistryPlayers('[]', 'src', 'dst')).toEqual({ value: null, legacyIds: [] });
    expect(retargetRegistryPlayers('{"players":[]}', 'src', 'dst')).toEqual({
      value: null,
      legacyIds: [],
    });
  });

  it('is idempotent', () => {
    const once = retargetRegistryPlayers(registry, 'src', 'dst');
    expect(retargetRegistryPlayers(once.value, 'src', 'dst').legacyIds).toEqual([]);
  });
});
