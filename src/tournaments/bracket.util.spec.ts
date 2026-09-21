import {
  applyResult,
  findMatch,
  generateBracket,
  groupRounds,
  nextPowerOfTwo,
  roundKey,
  totalRounds,
} from './bracket.util';

const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, name: `Team ${i + 1}` }));

describe('bracket.util', () => {
  describe('nextPowerOfTwo', () => {
    it('rounds up to the next power of two', () => {
      expect(nextPowerOfTwo(1)).toBe(1);
      expect(nextPowerOfTwo(2)).toBe(2);
      expect(nextPowerOfTwo(5)).toBe(8);
      expect(nextPowerOfTwo(8)).toBe(8);
      expect(nextPowerOfTwo(9)).toBe(16);
    });
  });

  describe('generateBracket', () => {
    it('returns nothing with fewer than two teams', () => {
      expect(generateBracket(teams(1))).toEqual([]);
      expect(generateBracket([])).toEqual([]);
    });

    it('builds a full tree for a power of two (no byes)', () => {
      const matches = generateBracket(teams(8), 'order');
      expect(matches).toHaveLength(7); // 4 + 2 + 1
      expect(totalRounds(matches)).toBe(3);
      expect(matches.filter((m) => m.status === 'bye')).toHaveLength(0);
      expect(matches.filter((m) => m.round === 1).every((m) => m.teamAId && m.teamBId)).toBe(true);
      // Later rounds start empty.
      expect(matches.filter((m) => m.round > 1).every((m) => !m.teamAId && !m.teamBId)).toBe(true);
    });

    it('keeps registration order when seeding is "order"', () => {
      const matches = generateBracket(teams(4), 'order');
      expect(findMatch(matches, 'r1m0')).toMatchObject({ teamAId: 't1', teamBId: 't2' });
      expect(findMatch(matches, 'r1m1')).toMatchObject({ teamAId: 't3', teamBId: 't4' });
    });

    it('adds byes for a non-power-of-two and auto-advances them', () => {
      const matches = generateBracket(teams(5), 'order');
      expect(matches).toHaveLength(7); // size 8
      const byes = matches.filter((m) => m.status === 'bye');
      expect(byes).toHaveLength(3);
      for (const m of byes) {
        expect(m.round).toBe(1);
        expect(m.teamBId).toBeNull();
        expect(m.winnerTeamId).toBe(m.teamAId);
      }
      // The only real round-1 match pairs the last two seeds.
      expect(findMatch(matches, 'r1m3')).toMatchObject({ teamAId: 't4', teamBId: 't5', status: 'pending' });
      // Byes are propagated into round 2.
      expect(findMatch(matches, 'r2m0')).toMatchObject({ teamAId: 't1', teamBId: 't2' });
      expect(findMatch(matches, 'r2m1')).toMatchObject({ teamAId: 't3', teamBId: null });
    });

    it('uses every team exactly once', () => {
      const matches = generateBracket(teams(6), 'random');
      const ids = matches
        .filter((m) => m.round === 1)
        .flatMap((m) => [m.teamAId, m.teamBId])
        .filter(Boolean)
        .sort();
      expect(ids).toEqual(teams(6).map((t) => t.id).sort());
    });
  });

  describe('applyResult', () => {
    it('infers the winner from the scores and advances it', () => {
      const initial = generateBracket(teams(4), 'order');
      const { matches, error } = applyResult(initial, 'r1m0', 2, 1);
      expect(error).toBeUndefined();
      expect(findMatch(matches, 'r1m0')).toMatchObject({ winnerTeamId: 't1', status: 'finished', scoreA: 2, scoreB: 1 });
      expect(findMatch(matches, 'r2m0')).toMatchObject({ teamAId: 't1', teamBId: null });
      // Pure: the input is not mutated.
      expect(findMatch(initial, 'r1m0')!.winnerTeamId).toBeNull();
    });

    it('places the winner of an odd position into slot B', () => {
      const { matches } = applyResult(generateBracket(teams(4), 'order'), 'r1m1', 0, 2);
      expect(findMatch(matches, 'r2m0')).toMatchObject({ teamAId: null, teamBId: 't4' });
    });

    it('requires an explicit winner on a draw', () => {
      const bracket = generateBracket(teams(4), 'order');
      expect(applyResult(bracket, 'r1m0', 1, 1).error).toBe('WINNER_REQUIRED');
      const { matches, error } = applyResult(bracket, 'r1m0', 1, 1, 't2');
      expect(error).toBeUndefined();
      expect(findMatch(matches, 'r1m0')!.winnerTeamId).toBe('t2');
    });

    it('rejects a winner that is not in the match', () => {
      expect(applyResult(generateBracket(teams(4), 'order'), 'r1m0', 2, 0, 't4').error).toBe('WINNER_NOT_IN_MATCH');
    });

    it('rejects unknown or incomplete matches', () => {
      const bracket = generateBracket(teams(4), 'order');
      expect(applyResult(bracket, 'nope', 1, 0).error).toBe('MATCH_NOT_FOUND');
      expect(applyResult(bracket, 'r2m0', 1, 0).error).toBe('MATCH_INCOMPLETE');
    });

    it('resets downstream results when a previous winner changes', () => {
      let m = generateBracket(teams(4), 'order');
      m = applyResult(m, 'r1m0', 2, 0).matches; // t1
      m = applyResult(m, 'r1m1', 2, 0).matches; // t3
      m = applyResult(m, 'r2m0', 2, 1).matches; // t1 champion
      expect(findMatch(m, 'r2m0')).toMatchObject({ winnerTeamId: 't1', status: 'finished' });

      // Reverse the first match: t2 now wins.
      m = applyResult(m, 'r1m0', 0, 2).matches;
      expect(findMatch(m, 'r2m0')).toMatchObject({
        teamAId: 't2',
        teamBId: 't3',
        winnerTeamId: null,
        scoreA: 0,
        scoreB: 0,
        status: 'pending',
      });
    });

    it('keeps downstream results when the same winner is re-entered', () => {
      let m = generateBracket(teams(4), 'order');
      m = applyResult(m, 'r1m0', 2, 0).matches;
      m = applyResult(m, 'r1m1', 2, 0).matches;
      m = applyResult(m, 'r2m0', 2, 1).matches;
      m = applyResult(m, 'r1m0', 2, 1).matches; // still t1
      expect(findMatch(m, 'r2m0')).toMatchObject({ winnerTeamId: 't1', status: 'finished' });
    });
  });

  describe('rounds', () => {
    it('names rounds from the end', () => {
      expect(roundKey(3, 3)).toBe('final');
      expect(roundKey(2, 3)).toBe('semi');
      expect(roundKey(1, 3)).toBe('quarter');
      expect(roundKey(1, 4)).toBe('round');
    });

    it('groups matches by round in position order', () => {
      const rounds = groupRounds(generateBracket(teams(8), 'order'));
      expect(rounds.map((r) => r.key)).toEqual(['quarter', 'semi', 'final']);
      expect(rounds[0].matches.map((m) => m.position)).toEqual([0, 1, 2, 3]);
    });
  });
});
