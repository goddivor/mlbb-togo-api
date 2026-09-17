import { NotFoundException } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlayerStatsService } from '../stats/player-stats.service';
import { UsersService } from '../users/users.service';

const U = 'user-1';
const NOW = new Date('2026-05-10T12:00:00Z');
const d = (iso: string) => new Date(iso);

function makePrisma() {
  const many = () => jest.fn().mockResolvedValue([]);
  return {
    notification: { count: jest.fn().mockResolvedValue(0), findMany: many() },
    esportTeamMember: { findMany: many() },
    esportMatch: { findMany: many() },
    esportTeam: { findMany: many() },
    tournament: { findMany: many() },
    draftRegistration: { findMany: many() },
    draftTeamMember: { findMany: many() },
    draftTournament: { findMany: many() },
    draftMatch: { findMany: many() },
    draftTeam: { findMany: many() },
    friendship: { findMany: many() },
    post: { findMany: many() },
    comment: { findMany: many() },
    user: { findMany: many(), findUnique: jest.fn().mockResolvedValue(null) },
  };
}

function makeStats() {
  return {
    getParticipations: jest.fn().mockResolvedValue([]),
    getUserMatches: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, hasMore: false }),
  };
}

function makeUsers() {
  return {
    leaderboard: jest.fn().mockResolvedValue({ metric: 'winRate', total: 0, entries: [] }),
  };
}

const matchItem = (n: number, result: 'win' | 'loss') => ({
  matchId: `m${n}`,
  date: d(`2026-05-0${n}T18:00:00Z`),
  result,
  team: { id: 'A', name: 'Alpha', image: null },
  opponent: { id: 'B', name: 'Beta', image: null },
  scoreFor: result === 'win' ? 2 : 0,
  scoreAgainst: result === 'win' ? 0 : 2,
  hero: 'Lancelot',
  isMvp: false,
});

describe('DashboardService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let stats: ReturnType<typeof makeStats>;
  let users: ReturnType<typeof makeUsers>;
  let service: DashboardService;

  beforeEach(() => {
    prisma = makePrisma();
    stats = makeStats();
    users = makeUsers();
    service = new DashboardService(
      prisma as unknown as PrismaService,
      stats as unknown as PlayerStatsService,
      users as unknown as UsersService,
    );
  });

  it('returns empty widgets for a fresh account', async () => {
    const out = await service.getDashboard(U, NOW);
    expect(out.quickStats).toMatchObject({ games: 0, winRate: 0, currentStreak: 0 });
    expect(out.rank).toEqual({ metric: 'winRate', position: null, total: 0, value: null, games: 0 });
    expect(out.lastMatches).toEqual([]);
    expect(out.upcoming).toEqual([]);
    expect(out.notifications).toEqual({ unread: 0, latest: [] });
    expect(out.activity).toEqual([]);
  });

  it('falls back on the user counters when no match rows exist', async () => {
    prisma.user.findUnique.mockResolvedValue({ wins: 3, losses: 1, mvpCount: 1, streak: 2 });
    const out = await service.getDashboard(U, NOW);
    expect(out.quickStats).toMatchObject({ games: 4, wins: 3, winRate: 75, currentStreak: 2 });
  });

  it('hides match widgets for staff accounts instead of failing', async () => {
    stats.getUserMatches.mockRejectedValue(new NotFoundException('nope'));
    const out = await service.getDashboard('admin', NOW);
    expect(out.lastMatches).toEqual([]);
  });

  it('computes the leaderboard position from the full ranking', async () => {
    users.leaderboard.mockResolvedValue({
      metric: 'winRate',
      total: 3,
      entries: [
        { id: 'x', winRate: 80, games: 5 },
        { id: U, winRate: 60, games: 10 },
        { id: 'y', winRate: 10, games: 1 },
      ],
    });
    const out = await service.getDashboard(U, NOW);
    expect(users.leaderboard).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'winRate', limit: Number.MAX_SAFE_INTEGER }),
    );
    expect(out.rank).toEqual({ metric: 'winRate', position: 2, total: 3, value: 60, games: 10 });
  });

  it('keeps only the last five matches and feeds the activity timeline', async () => {
    const items = [6, 5, 4, 3, 2, 1].map((n) => matchItem(n, n % 2 ? 'win' : 'loss'));
    stats.getUserMatches.mockResolvedValue({ items, total: 6, page: 1, limit: 10, hasMore: false });
    const out = await service.getDashboard(U, NOW);
    expect(out.lastMatches).toHaveLength(5);
    expect(out.lastMatches[0].matchId).toBe('m6');
    const matchEvents = out.activity.filter((e) => e.type === 'match');
    expect(matchEvents).toHaveLength(6);
    expect(matchEvents[0]).toMatchObject({
      id: 'match:m6',
      data: { result: 'loss', opponent: { name: 'Beta' } },
      link: '/teams/A',
    });
  });

  it('summarizes notifications with the unread count and the latest five', async () => {
    prisma.notification.count.mockResolvedValue(7);
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
    const out = await service.getDashboard(U, NOW);
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId: U, read: false } });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: U }, take: 5 }),
    );
    expect(out.notifications).toEqual({ unread: 7, latest: [{ id: 'n1' }, { id: 'n2' }] });
  });

  it('merges social events newest first', async () => {
    prisma.friendship.findMany.mockResolvedValue([
      { id: 'f1', requesterId: 'u9', addresseeId: U, status: 'accepted', updatedAt: d('2026-05-09T10:00:00Z') },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u9', username: 'nine', gameNickname: 'Nine', avatar: null, roleUser: 'user' },
    ]);
    prisma.post.findMany.mockResolvedValue([
      { id: 'p1', title: 'Hello', category: 'general', createdAt: d('2026-05-08T10:00:00Z') },
    ]);
    prisma.comment.findMany.mockResolvedValue([
      { id: 'c1', postId: 'p2', content: 'Nice one', createdAt: d('2026-05-09T11:00:00Z'), post: { id: 'p2', title: 'Other' } },
    ]);
    prisma.draftRegistration.findMany.mockResolvedValue([
      { id: 'r1', tournamentId: 't1', userId: U, preferredRole: 'jungle', createdAt: d('2026-05-07T10:00:00Z') },
    ]);
    // Mimic the status filter of the calendar query (the feed has none).
    const cup = { id: 't1', name: 'Cup', category: '5v5', status: 'completed', registrationClosesAt: null };
    prisma.draftTournament.findMany.mockImplementation(async (args: any) =>
      args?.where?.status?.in && !args.where.status.in.includes(cup.status) ? [] : [cup],
    );

    const out = await service.getDashboard(U, NOW);
    expect(out.activity.map((e) => e.type)).toEqual([
      'comment',
      'friend_accepted',
      'post',
      'draft_registration',
    ]);
    expect(out.activity[1]).toMatchObject({
      data: { userId: 'u9', name: 'Nine' },
      link: '/players/u9',
    });
    expect(out.activity[3]).toMatchObject({ data: { name: 'Cup', role: 'jungle' }, link: '/draft/t1' });
    // A completed draft tournament is no longer "upcoming".
    expect(out.upcoming).toEqual([]);
  });

  it('builds the calendar from esport matches, tournaments and drafts', async () => {
    prisma.esportTeamMember.findMany.mockResolvedValue([{ teamId: 'A' }]);
    prisma.esportMatch.findMany.mockResolvedValue([
      { id: 'em1', type: 'friendly', teamAId: 'B', teamBId: 'A', scheduledAt: d('2026-05-12T18:00:00Z'), status: 'scheduled' },
      { id: 'em2', type: 'official', teamAId: 'A', teamBId: 'C', scheduledAt: null, status: 'scheduled' },
    ]);
    prisma.esportTeam.findMany.mockResolvedValue([
      { id: 'A', name: 'Alpha', image: null },
      { id: 'B', name: 'Beta', image: null },
    ]);
    prisma.tournament.findMany.mockResolvedValue([
      {
        id: 'tt1',
        name: 'Open',
        status: 'upcoming',
        startDate: '2026-05-11',
        registeredTeams: '[{"id":"A","name":"Alpha"},{"id":"Z","name":"Zeta"}]',
        brackets: '[{"id":"b1","round":1,"status":"scheduled","teamAId":"Z","teamBId":"A","scheduledAt":"2026-05-14T20:00:00Z"},{"id":"b2","round":1,"status":"finished","teamAId":"A","teamBId":"Z","scheduledAt":null}]',
      },
      { id: 'tt2', name: 'Other', status: 'upcoming', startDate: '2026-06-01', registeredTeams: '["Q"]', brackets: '[]' },
    ]);
    prisma.draftRegistration.findMany.mockResolvedValue([
      { id: 'r1', tournamentId: 'dt1', userId: U, preferredRole: 'mid', createdAt: d('2026-05-01T00:00:00Z') },
    ]);
    prisma.draftTeamMember.findMany.mockResolvedValue([{ tournamentId: 'dt1', teamId: 'D1', userId: U }]);
    prisma.draftTournament.findMany.mockResolvedValue([
      { id: 'dt1', name: 'Community Cup', category: '5v5', status: 'ongoing', registrationClosesAt: d('2026-05-02T00:00:00Z') },
    ]);
    prisma.draftMatch.findMany.mockResolvedValue([
      { id: 'dm1', tournamentId: 'dt1', round: 1, position: 0, teamAId: 'D1', teamBId: 'D2', status: 'pending', scheduledAt: d('2026-05-13T19:00:00Z') },
    ]);
    prisma.draftTeam.findMany.mockResolvedValue([
      { id: 'D1', name: 'Team Red', icon: '' },
      { id: 'D2', name: 'Team Blue', icon: '' },
    ]);

    const out = await service.getDashboard(U, NOW);
    expect(out.upcoming.map((u) => u.id)).toEqual([
      'tournament:tt1', // 2026-05-11
      'esport:em1', // 2026-05-12
      'draftmatch:dm1', // 2026-05-13
      'bracket:tt1:b1', // 2026-05-14
      'esport:em2', // unscheduled last
    ]);
    // The draft tournament itself is out: registration closed before today.
    expect(out.upcoming.find((u) => u.id === 'draft:dt1')).toBeUndefined();
    expect(out.upcoming[1]).toMatchObject({
      kind: 'esport_match',
      data: { team: { name: 'Alpha' }, opponent: { name: 'Beta' } },
      link: '/teams/A',
    });
    expect(out.upcoming[3]).toMatchObject({
      kind: 'tournament_match',
      data: { opponent: { id: 'Z', name: 'Zeta' }, round: 1 },
    });
    expect(out.upcoming[2]).toMatchObject({
      kind: 'draft_match',
      data: { team: { name: 'Team Red' }, opponent: { name: 'Team Blue' } },
      link: '/draft/dt1',
    });
  });
});
