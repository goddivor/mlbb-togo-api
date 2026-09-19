import { BadRequestException } from '@nestjs/common';
import {
  assertResultMatchesGames,
  groupByDay,
  maxGames,
  normalizeGames,
  normalizeScreenshots,
  normalizeUrl,
  parseGames,
  parseScreenshots,
  resolveStage,
  scoreFromGames,
  serializeGames,
  stageFromType,
  typeFromStage,
  winsNeeded,
} from './esport-match-details';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const match = { teamAId: A, teamBId: B };

describe('match stage derivation', () => {
  it('derives the stage of legacy rows from the type', () => {
    expect(stageFromType('friendly')).toBe('scrim');
    expect(stageFromType('training')).toBe('scrim');
    expect(stageFromType('official')).toBe('league');
    expect(stageFromType(undefined)).toBe('scrim');
    expect(resolveStage({ type: 'official', stage: null })).toBe('league');
    expect(resolveStage({ type: 'friendly' })).toBe('scrim');
  });

  it('prefers an explicit stage and keeps the type in sync', () => {
    expect(resolveStage({ type: 'official', stage: 'playoff' })).toBe('playoff');
    expect(resolveStage({ type: 'friendly', stage: 'bogus' })).toBe('scrim');
    expect(typeFromStage('league')).toBe('official');
    expect(typeFromStage('playoff', 'friendly')).toBe('official');
    expect(typeFromStage('scrim', 'training')).toBe('training');
    expect(typeFromStage('scrim', 'official')).toBe('friendly');
  });
});

describe('formats', () => {
  it('knows the length of a series', () => {
    expect(maxGames('bo1')).toBe(1);
    expect(maxGames('bo3')).toBe(3);
    expect(maxGames('bo7')).toBe(7);
    expect(maxGames(null)).toBe(1);
    expect(winsNeeded('bo5')).toBe(3);
    expect(winsNeeded('bo1')).toBe(1);
  });
});

describe('games', () => {
  it('validates winners, durations and count against the format', () => {
    const games = normalizeGames(
      [
        { winnerTeamId: A, duration: '900', screenshot: 'https://x.io/1.png' },
        { winnerTeamId: B, duration: 1200.4 },
        { winnerTeamId: A },
      ],
      match,
      'bo3',
    );
    expect(games.map((g) => g.number)).toEqual([1, 2, 3]);
    expect(games[0]).toMatchObject({ winnerTeamId: A, duration: 900, screenshot: 'https://x.io/1.png' });
    expect(games[1].duration).toBe(1200);
    expect(scoreFromGames(games, match)).toEqual({ scoreA: 2, scoreB: 1, winnerTeamId: A });
  });

  it('rejects invalid games', () => {
    expect(() => normalizeGames([{ winnerTeamId: 'zzz' }], match, 'bo1')).toThrow(BadRequestException);
    expect(() => normalizeGames([{}, {}], match, 'bo1')).toThrow(BadRequestException);
    expect(() => normalizeGames([{ duration: -1 }], match, 'bo1')).toThrow(BadRequestException);
    expect(() => normalizeGames([{ screenshot: 'ftp://x' }], match, 'bo1')).toThrow(BadRequestException);
    expect(() => normalizeGames('nope', match, 'bo1')).toThrow(BadRequestException);
    // 3 wins for A is impossible in a bo3 (2 needed).
    expect(() =>
      normalizeGames([{ winnerTeamId: A }, { winnerTeamId: A }, { winnerTeamId: A }], match, 'bo3'),
    ).toThrow(BadRequestException);
  });

  it('accepts a series in progress (games without winner)', () => {
    const games = normalizeGames([{ winnerTeamId: A }, {}], match, 'bo3');
    expect(scoreFromGames(games, match)).toEqual({ scoreA: 1, scoreB: 0, winnerTeamId: A });
  });

  it('round-trips through JSON and tolerates corrupt storage', () => {
    const games = normalizeGames([{ winnerTeamId: B, duration: 700, mvpUserId: 'u1' }], match, 'bo1');
    const json = serializeGames(games);
    expect(parseGames(json)).toEqual([
      { number: 1, winnerTeamId: B, duration: 700, mvpUserId: 'u1', screenshot: null },
    ]);
    expect(serializeGames([])).toBeNull();
    expect(parseGames(null)).toEqual([]);
    expect(parseGames('{bad')).toEqual([]);
    expect(parseGames('[1, null, {"winnerTeamId": 3}]')).toEqual([
      { number: 1, winnerTeamId: null, duration: null, mvpUserId: null, screenshot: null },
    ]);
  });
});

describe('result / games consistency', () => {
  const games = normalizeGames([{ winnerTeamId: A }, { winnerTeamId: B }, { winnerTeamId: A }], match, 'bo3');

  it('accepts a matching score and winner', () => {
    expect(() => assertResultMatchesGames(games, match, { scoreA: 2, scoreB: 1, winnerTeamId: A })).not.toThrow();
    expect(() => assertResultMatchesGames(games, match, { winnerTeamId: A })).not.toThrow();
    expect(() => assertResultMatchesGames([], match, { scoreA: 9, winnerTeamId: B })).not.toThrow();
  });

  it('rejects a score or winner that contradicts the games', () => {
    expect(() => assertResultMatchesGames(games, match, { scoreA: 1, scoreB: 2 })).toThrow(BadRequestException);
    expect(() => assertResultMatchesGames(games, match, { winnerTeamId: B })).toThrow(BadRequestException);
    const tied = normalizeGames([{ winnerTeamId: A }, { winnerTeamId: B }], match, 'bo3');
    expect(() => assertResultMatchesGames(tied, match, { winnerTeamId: A })).toThrow(BadRequestException);
  });
});

describe('screenshots and links', () => {
  it('keeps at most 10 unique http(s) URLs', () => {
    expect(normalizeScreenshots(undefined)).toBeNull();
    expect(normalizeScreenshots([])).toBeNull();
    const json = normalizeScreenshots(['https://a.io/1.png', ' https://a.io/1.png ', 'http://b.io/2.jpg', '']);
    expect(parseScreenshots(json)).toEqual(['https://a.io/1.png', 'http://b.io/2.jpg']);
    expect(() => normalizeScreenshots(['javascript:alert(1)'])).toThrow(BadRequestException);
    expect(() => normalizeScreenshots('https://a.io')).toThrow(BadRequestException);
    expect(() =>
      normalizeScreenshots(Array.from({ length: 11 }, (_, i) => `https://a.io/${i}.png`)),
    ).toThrow(BadRequestException);
    expect(parseScreenshots('["https://ok.io/x.png", "nope", 3]')).toEqual(['https://ok.io/x.png']);
  });

  it('validates optional urls', () => {
    expect(normalizeUrl('', 'VOD')).toBeNull();
    expect(normalizeUrl(null, 'VOD')).toBeNull();
    expect(normalizeUrl('https://youtu.be/abc', 'VOD')).toBe('https://youtu.be/abc');
    expect(() => normalizeUrl('youtu.be/abc', 'VOD')).toThrow(BadRequestException);
  });
});

describe('calendar grouping', () => {
  it('groups by UTC day, oldest first, ordered inside the day', () => {
    const { days, undated } = groupByDay([
      { id: 1, scheduledAt: '2026-03-02T20:00:00Z' },
      { id: 2, scheduledAt: '2026-03-01T18:00:00Z' },
      { id: 3, scheduledAt: '2026-03-02T15:00:00Z' },
      { id: 4, scheduledAt: null },
      { id: 5, scheduledAt: 'garbage' },
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02']);
    expect(days[1].matches.map((m: any) => m.id)).toEqual([3, 1]);
    expect(undated.map((m: any) => m.id)).toEqual([4, 5]);
  });
});
