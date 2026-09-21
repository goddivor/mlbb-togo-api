import {
  bidOf,
  mapCareerStats,
  mapFrequentHeroes,
  mapHeroMatches,
  mapMatchDetail,
  mapRecentMatches,
  mapSeasons,
} from './game.mappers';
import { mapBaseInfo } from './game-sync.service';
import { samples } from './__fixtures__/battlereport.samples';

describe('battle report mappers (Arena OpenAPI samples)', () => {
  it('maps career stats with legacy keys and records', () => {
    const s = mapCareerStats(samples.stats.data);
    expect(s).toMatchObject({
      wins: 188,
      total: 308,
      losses: 120,
      winRate: 61,
      avgScore: 7.62,
      gameTime: 77.95,
      mvpCount: 73,
      winStreak: 11,
    });
    expect(s.records.mostKills).toMatchObject({
      value: 25,
      heroId: 84,
      heroName: 'Ling',
      bid: '4108435467847910024',
    });
    expect(s.records.bestScore.value).toBe(13.3);
    expect(s.records.mostGold.value).toBe(22282);
    expect(Object.keys(s.records).sort()).toEqual(
      ['bestScore', 'mostAssists', 'mostDamage', 'mostDamageTaken', 'mostGold', 'mostKills', 'mostTotalDamage'].sort(),
    );
  });

  it('tolerates an empty stats payload', () => {
    expect(mapCareerStats(null)).toMatchObject({ wins: 0, total: 0, winRate: 0, records: {} });
  });

  it('maps season ids newest first, deduplicated', () => {
    expect(mapSeasons(samples.season.data)).toEqual([40, 39, 38, 37]);
    expect(mapSeasons({ sids: [37, '40', 39, 40, 'x'] })).toEqual([40, 39, 37]);
    expect(mapSeasons(undefined)).toEqual([]);
  });

  it('maps recent matches with the exact battle id and cursor', () => {
    const page = mapRecentMatches(samples.matches.data, 40);
    expect(page.page).toEqual({ nextCursor: '4143043017340290910', hasNext: true });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      bid: '4132717739868068534',
      sid: 40,
      heroId: 17,
      heroName: 'Fanny',
      kills: 14,
      deaths: 1,
      assists: 11,
      laneId: 4,
      score: 11.8,
      mvp: false,
      win: true,
    });
    expect(page.items[0].playedAt.toISOString()).toBe(new Date(1774857999 * 1000).toISOString());
  });

  it('prefers bid_s over the rounded numeric bid', () => {
    expect(bidOf({ bid: 4132717739868068400, bid_s: '4132717739868068534' })).toBe('4132717739868068534');
    expect(bidOf({ bid: 12 })).toBe('12');
    expect(bidOf({})).toBeNull();
  });

  it('ends pagination when the cursor is empty', () => {
    const page = mapFrequentHeroes(samples.frequent.data);
    expect(page.page).toEqual({ nextCursor: null, hasNext: false });
    expect(page.items[0]).toMatchObject({
      heroId: 17,
      name: 'Fanny',
      matches: 8,
      wins: 7,
      winRate: 87.5,
      power: 1460,
      avgScore: 8.45,
    });
  });

  it('maps per-hero matches with the hero record', () => {
    const r = mapHeroMatches(samples.heroMatches.data, 40);
    expect(r.hero).toMatchObject({ heroId: 17, matches: 9, wins: 8, winRate: 88.9 });
    expect(r.items[0]).toMatchObject({ bid: '4138442308503475824', kills: 7, score: 8.1, win: true });
  });

  it('maps a match detail scoreboard without other players ids', () => {
    const d = mapMatchDetail(samples.matchDetail.data, 1880233572);
    expect(d.durationSec).toBe(1292);
    expect(d.teams).toEqual([{ team: 2, kills: 24, win: false }]);
    const p = d.players[0];
    expect(p).toMatchObject({
      team: 2,
      name: 'ᴵᵐŦungiℓ',
      isSelf: true,
      heroId: 31,
      heroName: 'Moskov',
      heroLevel: 15,
      kills: 4,
      deaths: 9,
      assists: 6,
      kda: 1.11,
      teamfight: 41.7,
      damage: 83974,
      damageShare: 22,
      score: 5.09,
      mvp: false,
      win: false,
    });
    // Item 0 slots are dropped; names come from its_e when present.
    expect(p.items).toHaveLength(6);
    expect(p.items[0]).toEqual({ id: 2305, name: 'Swift Boots', image: expect.stringContaining('youngjoygame') });
    expect(p.items[1]).toEqual({ id: 3002, name: null, image: null });
    expect(JSON.stringify(d)).not.toContain('1880233572');
    expect(JSON.stringify(d)).not.toContain('57027');
  });

  it('flags nobody when the owner is unknown', () => {
    expect(mapMatchDetail(samples.matchDetail.data).players[0].isSelf).toBe(false);
    expect(mapMatchDetail(null)).toEqual({ durationSec: null, playedAt: null, teams: [], players: [] });
  });

  it('maps getBaseInfo identity', () => {
    expect(mapBaseInfo(samples.info.data)).toEqual({
      nickname: 'SAYA AKAN LAWAN',
      avatar: expect.stringContaining('akmpicture'),
      level: 200,
      rankLevel: 8000,
      peakRankLevel: 9999,
      country: 'ID',
    });
  });
});
