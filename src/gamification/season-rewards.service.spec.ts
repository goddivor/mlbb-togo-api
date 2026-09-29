import { resetLegacyCache } from '../esport/legacy-import.guard';
import {
  SeasonRewardsService,
  finalPodium,
  invinciblePlayers,
  seasonVariant,
  teamPlayers,
} from './season-rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { GamificationService } from './gamification.service';
import { RewardsService } from '../rewards/rewards.service';

describe('season rewards: pure helpers', () => {
  it('builds the season variant', () => {
    expect(seasonVariant(3)).toBe('S3');
    expect(seasonVariant(null)).toBeNull();
    expect(seasonVariant(0)).toBeNull();
  });

  it('prefers the playoffs podium to the regular one', () => {
    const summary = {
      podium: [{ placement: 1, teamId: 'reg' }],
      playoffsPodium: [
        { placement: 1, teamId: 'po1' },
        { placement: 2, teamId: 'po2' },
      ],
    };
    expect(finalPodium(summary)).toEqual([
      { placement: 1, teamId: 'po1' },
      { placement: 2, teamId: 'po2' },
    ]);
    expect(finalPodium({ podium: [{ placement: 1, teamId: 'reg' }], playoffsPodium: [] })).toEqual([
      { placement: 1, teamId: 'reg' },
    ]);
    expect(finalPodium(null)).toEqual([]);
  });

  it('finds unbeaten players with at least 5 matches for the team', () => {
    const participations = new Map([
      ['p1', new Map([['t1', 6]])],
      ['p2', new Map([['t1', 4]])],
      ['p3', new Map([['t2', 9]])],
    ]);
    const facts = {
      podium: [],
      standings: [
        { teamId: 't1', played: 8, losses: 0 },
        { teamId: 't2', played: 8, losses: 1 },
      ],
      participations,
    };
    expect(invinciblePlayers(facts)).toEqual(['p1']);
    expect(teamPlayers(participations, 't1')).toEqual(['p1', 'p2']);
  });
});

describe('SeasonRewardsService', () => {
  beforeEach(() => resetLegacyCache());

  const season = {
    id: 's2',
    name: 'Saison 2',
    number: 2,
    status: 'closed',
    closedAt: new Date('2026-09-01T00:00:00Z'),
    summary: JSON.stringify({
      podium: [
        { placement: 1, teamId: 'champ' },
        { placement: 2, teamId: 'second' },
      ],
      standings: [
        { teamId: 'champ', played: 6, losses: 0 },
        { teamId: 'second', played: 6, losses: 3 },
      ],
    }),
  };

  function setup(holders: { userId: string; frameId: string; variant: string; expiresAt: null; expiredAt: null }[]) {
    const prisma: any = {
      esportSeason: {
        findUnique: jest.fn(async () => season),
        findFirst: jest.fn(async () => ({ id: 's2' })),
      },
      esportMatch: {
        findMany: jest.fn(async () => [
          { id: 'm1', stage: 'league', type: 'official' },
          { id: 'm2', stage: 'scrim', type: 'friendly' },
        ]),
      },
      esportMatchPlayer: {
        findMany: jest.fn(async () =>
          [...Array(5)].flatMap(() => [
            { userId: 'ace', teamId: 'champ' },
            { userId: 'runner', teamId: 'second' },
          ]),
        ),
      },
      seasonAward: {
        findMany: jest.fn(async () => [
          { id: 'aw1', category: 'mvp', userId: 'ace', title: null },
          { id: 'aw2', category: 'best_roam', userId: 'runner', title: null },
        ]),
      },
      user: { findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: string) => ({ id }))) },
      userFrame: { findMany: jest.fn(async () => holders) },
      esportTeamMember: { findMany: jest.fn(async () => []) },
    };
    const gamification = {
      trackSafe: jest.fn(async () => ({ granted: true })),
      checkSafe: jest.fn(async () => []),
      unlockAchievement: jest.fn(async () => true),
    };
    const rewards = {
      grantFrameSafe: jest.fn(async () => ({})),
      endFrame: jest.fn(async () => ({ ended: true })),
    };
    const service = new SeasonRewardsService(
      prisma as PrismaService,
      gamification as unknown as GamificationService,
      rewards as unknown as RewardsService,
    );
    return { service, gamification, rewards };
  }

  it('grants nothing at all for a season made of imported matches (#153)', async () => {
    const { service, gamification, rewards } = setup([
      { userId: 'old-champion', frameId: 'champion_en_titre', variant: '', expiresAt: null, expiredAt: null },
    ]);
    // The registry lists the season itself: it is an archive for ever, even
    // with a real match played in it (the third match below is not imported).
    (service as any).prisma.appSetting = {
      findUnique: jest.fn(async () => ({
        value: JSON.stringify({
          seasons: { '1': 'bbbbbbbbbbbbbbbbbbbbbbb2' },
          matches: { '1': 'aaaaaaaaaaaaaaaaaaaaaaa1', '2': 'aaaaaaaaaaaaaaaaaaaaaaa2' },
        }),
      })),
    };
    (service as any).prisma.esportMatch.findMany = jest.fn(async () => [
      { id: 'aaaaaaaaaaaaaaaaaaaaaaa1', seasonId: 's2', stage: 'league', type: 'official' },
      { id: 'aaaaaaaaaaaaaaaaaaaaaaa2', seasonId: 's2', stage: 'league', type: 'official' },
      { id: 'realmatch', seasonId: 's2', stage: 'league', type: 'official' },
    ]);
    (service as any).prisma.esportSeason.findUnique = jest.fn(async () => ({
      ...season,
      id: 'bbbbbbbbbbbbbbbbbbbbbbb2',
    }));
    resetLegacyCache();
    expect(await service.apply('bbbbbbbbbbbbbbbbbbbbbbb2')).toBeNull();
    expect(gamification.trackSafe).not.toHaveBeenCalled();
    expect(rewards.grantFrameSafe).not.toHaveBeenCalled();
    // And above all: the real holder keeps his reigning-champion frame.
    expect(rewards.endFrame).not.toHaveBeenCalled();
  });

  it('never pays an award the import created, even in a season the team created (#153)', async () => {
    const { service, gamification } = setup([]);
    (service as any).prisma.appSetting = {
      findUnique: jest.fn(async () => ({
        value: JSON.stringify({ awards: { '1': 'cccccccccccccccccccccca1' } }),
      })),
    };
    (service as any).prisma.seasonAward.findMany = jest.fn(async () => [
      { id: 'cccccccccccccccccccccca1', category: 'mvp', userId: 'imported', title: null },
      { id: 'real', category: 'best_roam', userId: 'runner', title: null },
    ]);
    resetLegacyCache();
    await service.apply('s2');
    const awarded = gamification.trackSafe.mock.calls.filter((c: any[]) => c[1] === 'season_award').map((c: any[]) => c[0]);
    expect(awarded).toEqual(['runner']);
  });

  it('grants participation, podium XP, awards and the season variant frames', async () => {
    const { service, gamification, rewards } = setup([]);
    const out = await service.apply('s2');
    const calls = gamification.trackSafe.mock.calls.map((c: any[]) => [c[0], c[1], c[3]?.amount]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['ace', 'season_participation', undefined],
        ['runner', 'season_participation', undefined],
        ['ace', 'season_podium', 500],
        ['runner', 'season_podium', 300],
        ['ace', 'season_win', undefined],
        ['ace', 'season_award', 800],
        ['runner', 'season_award', 500],
      ]),
    );
    expect(calls.some(([u, t]) => u === 'runner' && t === 'season_win')).toBe(false);
    const frames = rewards.grantFrameSafe.mock.calls.map((c: any[]) => [c[0], c[1], c[2].variant ?? '']);
    expect(frames).toEqual(
      expect.arrayContaining([
        ['ace', 'champion_saison', 'S2'],
        ['ace', 'champion_en_titre', ''],
        ['ace', 'mvp_saison', 'S2'],
        ['runner', 'voie_roam', 'S2'],
      ]),
    );
    expect(out?.champions).toEqual(['ace']);
    // Unbeaten team, 5 league matches for the champion.
    expect(gamification.unlockAchievement).toHaveBeenCalledWith('ace', 'invincibles', expect.anything());
  });

  it('transfers champion_en_titre from the previous champions to the new ones', async () => {
    const { service, rewards } = setup([
      { userId: 'old', frameId: 'champion_en_titre', variant: '', expiresAt: null, expiredAt: null },
      { userId: 'ace', frameId: 'champion_en_titre', variant: '', expiresAt: null, expiredAt: null },
    ]);
    await service.apply('s2');
    expect(rewards.endFrame).toHaveBeenCalledTimes(1);
    expect(rewards.endFrame).toHaveBeenCalledWith('old', 'champion_en_titre', '');
    expect(rewards.grantFrameSafe).toHaveBeenCalledWith('ace', 'champion_en_titre', expect.objectContaining({ source: 'award' }));
  });

  it('stops at its deadline and reports an incomplete run (finished later by the daily job)', async () => {
    const { service, gamification } = setup([]);
    const res = await service.apply('s2', new Date(), Date.now() - 1);
    expect(res).toMatchObject({ complete: false });
    expect(gamification.trackSafe).not.toHaveBeenCalled();
    const full = await service.apply('s2');
    expect(full).toMatchObject({ complete: true });
  });

  it('does nothing for a season that is not closed', async () => {
    const { service, gamification } = setup([]);
    season.status = 'active';
    expect(await service.apply('s2')).toBeNull();
    expect(gamification.trackSafe).not.toHaveBeenCalled();
    season.status = 'closed';
  });
});
