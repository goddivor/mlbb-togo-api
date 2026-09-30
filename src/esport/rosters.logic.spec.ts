import {
  isActiveStint,
  resolveRosterSeasonId,
  isCurrentMember,
  orderRoster,
  playerTeamHistory,
  rosterSeasonIds,
  selectSeasonRoster,
} from './rosters.logic';

const S1 = 's1';
const S2 = 's2';

describe('selectSeasonRoster', () => {
  it('gives a past season its archived roster, not the live one', () => {
    const rows = [
      { id: 'a', userId: 'u1', seasonId: S1 },
      { id: 'b', userId: 'u2', seasonId: S1 },
      { id: 'c', userId: 'u9' }, // live member, joined since
    ];
    expect(selectSeasonRoster(rows, { seasonId: S1, currentSeasonId: S2 }).map((m) => m.userId)).toEqual([
      'u1',
      'u2',
    ]);
  });

  it('shows the live members on the current season', () => {
    const rows = [
      { id: 'a', userId: 'u1', seasonId: S1 },
      { id: 'c', userId: 'u9' },
    ];
    expect(selectSeasonRoster(rows, { seasonId: S2, currentSeasonId: S2 }).map((m) => m.userId)).toEqual(['u9']);
  });

  it('lets the same player belong to two teams in two different seasons', () => {
    const alpha = [{ id: 'a', teamId: 't1', userId: 'u1', seasonId: S1 }];
    const beta = [{ id: 'b', teamId: 't2', userId: 'u1', seasonId: S2 }];
    expect(selectSeasonRoster(alpha, { seasonId: S1, currentSeasonId: S2 })).toHaveLength(1);
    expect(selectSeasonRoster(beta, { seasonId: S2, currentSeasonId: S2 })).toHaveLength(1);
    expect(selectSeasonRoster(alpha, { seasonId: S2, currentSeasonId: S2 })).toHaveLength(0);
  });

  it('lists a player once when he holds both the archived and the live row', () => {
    const rows = [
      { id: 'live', userId: 'u1', role: null },
      { id: 'arch', userId: 'u1', role: 'jungle', seasonId: S2 },
    ];
    const roster = selectSeasonRoster(rows, { seasonId: S2, currentSeasonId: S2 });
    expect(roster).toHaveLength(1);
    // The season row wins: it carries the role he had that season.
    expect(roster[0].id).toBe('arch');
  });

  it('keeps a loaned substitute in the roster of his season', () => {
    const rows = [{ id: 'sub', userId: 'u5', seasonId: S1, isSubstitute: true }];
    expect(selectSeasonRoster(rows, { seasonId: S1, currentSeasonId: S2 })).toHaveLength(1);
  });

  it('drops a player who left, unless asked for the full history', () => {
    const rows = [
      { id: 'a', userId: 'u1' },
      { id: 'b', userId: 'u2', leftAt: '2025-01-01T00:00:00.000Z' },
    ];
    expect(selectSeasonRoster(rows, { currentSeasonId: S2 }).map((m) => m.userId)).toEqual(['u1']);
    expect(selectSeasonRoster(rows, { currentSeasonId: S2, includeLeft: true })).toHaveLength(2);
  });

  it('counts the current roster of a team abandoned after a season as empty', () => {
    const rows = [
      { id: 'a', userId: 'u1', seasonId: S1 },
      { id: 'b', userId: 'u2', seasonId: S1 },
    ];
    expect(selectSeasonRoster(rows, { seasonId: S2, currentSeasonId: S2 })).toHaveLength(0);
    expect(selectSeasonRoster(rows, { seasonId: S1, currentSeasonId: S2 })).toHaveLength(2);
  });

  it('falls back to the live roster when the site has no season at all', () => {
    const rows = [{ id: 'a', userId: 'u1' }, { id: 'b', userId: 'u2', seasonId: S1 }];
    expect(selectSeasonRoster(rows, {}).map((m) => m.userId)).toEqual(['u1']);
  });

  it('survives an empty or broken list', () => {
    expect(selectSeasonRoster([] as any, { seasonId: S1 })).toEqual([]);
    expect(selectSeasonRoster([null, undefined] as any, { seasonId: S1 })).toEqual([]);
  });
});

describe('orderRoster', () => {
  it('puts the captain first and the substitutes last', () => {
    const rows = [
      { id: 'c', userId: 'u3', isSubstitute: true, sort: 0 },
      { id: 'b', userId: 'u2', sort: 2 },
      { id: 'a', userId: 'u1', isCaptain: true, sort: 9 },
    ];
    expect(orderRoster(rows).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('isActiveStint / isCurrentMember', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('treats a stint without a departure as open', () => {
    expect(isActiveStint({ userId: 'u1' }, now)).toBe(true);
    expect(isActiveStint({ userId: 'u1', leftAt: '2025-06-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isActiveStint({ userId: 'u1', leftAt: '2026-06-01T00:00:00.000Z' }, now)).toBe(true);
  });

  it('answers "is he still in the team now?"', () => {
    expect(isCurrentMember({ userId: 'u1' }, S2, now)).toBe(true);
    expect(isCurrentMember({ userId: 'u1', seasonId: S2 }, S2, now)).toBe(true);
    expect(isCurrentMember({ userId: 'u1', seasonId: S1 }, S2, now)).toBe(false);
    expect(isCurrentMember({ userId: 'u1', leftAt: '2025-06-01T00:00:00.000Z' }, S2, now)).toBe(false);
  });
});

describe('rosterSeasonIds', () => {
  it('lists the seasons a team has an archived roster for, once each', () => {
    expect(
      rosterSeasonIds([
        { userId: 'u1', seasonId: S1 },
        { userId: 'u2', seasonId: S1 },
        { userId: 'u3' },
        { userId: 'u4', seasonId: S2 },
      ]),
    ).toEqual([S1, S2]);
  });
});

describe('playerTeamHistory', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('lists every team with its seasons and says where he still plays', () => {
    const history = playerTeamHistory(
      [
        { id: '1', teamId: 't1', userId: 'u1', seasonId: S1, role: 'jungle' },
        { id: '2', teamId: 't1', userId: 'u1', seasonId: S2, role: 'mid' },
        { id: '3', teamId: 't2', userId: 'u1', seasonId: S1, isSubstitute: true },
      ],
      S2,
      now,
    );
    const t1 = history.find((h) => h.teamId === 't1')!;
    const t2 = history.find((h) => h.teamId === 't2')!;
    expect(t1.seasonIds).toEqual([S1, S2]);
    expect(t1.roles).toEqual(['jungle', 'mid']);
    expect(t1.isCurrent).toBe(true);
    expect(t2.isCurrent).toBe(false);
    expect(t2.wasSubstitute).toBe(true);
  });

  it('marks a team he left as not current and keeps the departure date', () => {
    const history = playerTeamHistory(
      [{ id: '1', teamId: 't1', userId: 'u1', leftAt: '2025-03-01T00:00:00.000Z' }],
      S2,
      now,
    );
    expect(history[0].isCurrent).toBe(false);
    expect(history[0].leftAt).toBe('2025-03-01T00:00:00.000Z');
  });

  it('ignores rows without a team', () => {
    expect(playerTeamHistory([{ userId: 'u1' }] as any, S2, now)).toEqual([]);
  });
});

describe('resolveRosterSeasonId', () => {
  it('stays on the current season when the team still has players', () => {
    const rows = [{ id: 'a', userId: 'u1' }];
    expect(resolveRosterSeasonId(rows, { currentSeasonId: S2, seasonOrder: [S2, S1] })).toBe(S2);
  });

  it('falls back to the last season played by a team abandoned since', () => {
    const rows = [
      { id: 'a', userId: 'u1', seasonId: S1 },
      { id: 'b', userId: 'u2', seasonId: S2 },
    ];
    expect(resolveRosterSeasonId(rows, { currentSeasonId: 's3', seasonOrder: ['s3', S2, S1] })).toBe(S2);
  });

  it('never overrides an explicit season', () => {
    const rows = [{ id: 'a', userId: 'u1', seasonId: S1 }];
    expect(resolveRosterSeasonId(rows, { seasonId: S2, currentSeasonId: S2 })).toBe(S2);
  });

  it('keeps the current season for a team that never had anybody', () => {
    expect(resolveRosterSeasonId([], { currentSeasonId: S2, seasonOrder: [S2, S1] })).toBe(S2);
  });
});
