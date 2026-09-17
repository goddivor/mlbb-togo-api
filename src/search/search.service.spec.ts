import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';

const userRow = (over: Partial<Record<string, any>> = {}) => ({
  id: over.username ? `id-${over.username}` : 'id-x',
  username: 'testuser',
  displayName: 'Test User',
  avatar: null,
  roleUser: 'user',
  country: 'Togo',
  isOnline: false,
  gameRankLevel: null,
  gameLevel: null,
  wins: 0,
  losses: 0,
  mvpCount: 0,
  badges: '[]',
  googleId: null,
  mlbbRoleId: null,
  profileSource: 'game',
  googleName: null,
  googleAvatar: null,
  gameNickname: null,
  gameAvatar: null,
  ...over,
});

const heroRow = (over: Partial<Record<string, any>> = {}) => ({
  id: 'hero-1',
  name: 'Alucard',
  role: 'fighter',
  image: null,
  description: 'A powerful fighter',
  ...over,
});

const teamRow = (over: Partial<Record<string, any>> = {}) => ({
  id: 'team-1',
  name: 'Dream Team',
  tag: 'DRM',
  logo: null,
  description: 'A competitive team',
  region: 'Togo',
  wins: 10,
  losses: 5,
  ...over,
});

const tournamentRow = (over: Partial<Record<string, any>> = {}) => ({
  id: 'tournament-1',
  name: 'MLBB Championship',
  description: 'Annual championship',
  status: 'ongoing',
  startDate: '2025-01-01',
  banner: null,
  ...over,
});

const eventRow = (over: Partial<Record<string, any>> = {}) => ({
  id: 'event-1',
  title: 'Weekly Tournament',
  type: 'tournament',
  description: 'Weekly event',
  date: '2025-09-20',
  isPublic: true,
  ...over,
});

describe('SearchService', () => {
  let service: SearchService;
  let prisma: {
    user: { findMany: jest.Mock };
    hero: { findMany: jest.Mock };
    team: { findMany: jest.Mock };
    tournament: { findMany: jest.Mock };
    event: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn() },
      hero: { findMany: jest.fn() },
      team: { findMany: jest.fn() },
      tournament: { findMany: jest.fn() },
      event: { findMany: jest.fn() },
    };
    service = new SearchService(prisma as unknown as PrismaService);
  });

  describe('empty and short queries', () => {
    it('returns empty groups for empty query', async () => {
      const res = await service.search({ q: '' });

      expect(res).toEqual({
        users: [],
        heroes: [],
        teams: [],
        tournaments: [],
        events: [],
      });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns empty groups for undefined query', async () => {
      const res = await service.search();

      expect(res).toEqual({
        users: [],
        heroes: [],
        teams: [],
        tournaments: [],
        events: [],
      });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns empty groups for single character query', async () => {
      const res = await service.search({ q: 'a' });

      expect(res).toEqual({
        users: [],
        heroes: [],
        teams: [],
        tournaments: [],
        events: [],
      });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns results for two character query', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      await service.search({ q: 'ab' });

      expect(prisma.user.findMany).toHaveBeenCalled();
    });
  });

  describe('grouping by type', () => {
    it('returns results grouped by entity type', async () => {
      const testUser = userRow({ username: 'player1' });
      const testHero = heroRow({ name: 'Alucard' });
      const testTeam = teamRow({ name: 'Team A' });
      const testTournament = tournamentRow({ name: 'Tournament A' });
      const testEvent = eventRow({ title: 'Event A' });

      prisma.user.findMany.mockResolvedValue([testUser]);
      prisma.hero.findMany.mockResolvedValue([testHero]);
      prisma.team.findMany.mockResolvedValue([testTeam]);
      prisma.tournament.findMany.mockResolvedValue([testTournament]);
      prisma.event.findMany.mockResolvedValue([testEvent]);

      const res = await service.search({ q: 'test' });

      expect(res.users).toHaveLength(1);
      expect(res.heroes).toHaveLength(1);
      expect(res.teams).toHaveLength(1);
      expect(res.tournaments).toHaveLength(1);
      expect(res.events).toHaveLength(1);
    });

    it('excludes banned users', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      await service.search({ q: 'test' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isBanned: false,
          }),
        }),
      );
    });

    it('excludes staff (admin/moderator) users', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      await service.search({ q: 'test' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roleUser: { notIn: ['admin', 'moderator'] },
          }),
        }),
      );
    });
  });

  describe('limit parameter', () => {
    it('uses default limit of 5 per type', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      await service.search({ q: 'test' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
      expect(prisma.hero.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('respects custom limit parameter', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      await service.search({ q: 'test', limit: 10 });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });

    it('caps results at specified limit', async () => {
      const users = Array.from({ length: 3 }, (_, i) =>
        userRow({ username: `user${i}` }),
      );
      prisma.user.findMany.mockResolvedValue(users);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      const res = await service.search({ q: 'test', limit: 2 });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2 }),
      );
    });
  });

  describe('PII protection', () => {
    it('does not leak password field in serialized users', async () => {
      const testUser = userRow({ username: 'secret-user' });
      prisma.user.findMany.mockResolvedValue([testUser]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      const res = await service.search({ q: 'test' });

      expect(res.users[0]).not.toHaveProperty('password');
    });

    it('does not leak mlbbToken field in serialized users', async () => {
      const testUser = userRow({ username: 'secret-user' });
      prisma.user.findMany.mockResolvedValue([testUser]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      const res = await service.search({ q: 'test' });

      expect(res.users[0]).not.toHaveProperty('mlbbToken');
    });

    it('preserves allowed public user fields', async () => {
      const testUser = userRow({
        username: 'public-user',
        displayName: 'Public Name',
      });
      prisma.user.findMany.mockResolvedValue([testUser]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      const res = await service.search({ q: 'test' });

      expect(res.users[0]).toHaveProperty('username', 'public-user');
      expect(res.users[0]).toHaveProperty('displayName');
    });
  });

  describe('case-insensitive search', () => {
    it('searches with case-insensitive pattern', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.hero.findMany.mockResolvedValue([]);
      prisma.team.findMany.mockResolvedValue([]);
      prisma.tournament.findMany.mockResolvedValue([]);
      prisma.event.findMany.mockResolvedValue([]);

      await service.search({ q: 'TeSt' });

      // Check that a case-insensitive regex pattern is passed
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            username: expect.objectContaining({
              $regex: 'TeSt',
              $options: 'i',
            }),
          }),
        }),
      );
    });
  });
});
