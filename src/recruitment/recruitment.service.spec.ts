import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RecruitmentService } from './recruitment.service';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from '../community/community.service';

/** Minimal user row, shaped like what Prisma returns. */
const userRow = (over: Record<string, any> = {}) => ({
  id: 'u-candidate',
  username: 'candidate',
  email: 'candidate@mlbb.tg',
  password: 'hashed',
  mlbbToken: 'super-secret-token',
  avatar: null,
  rank: 'warrior',
  role: 'fighter',
  favoriteHeroes: '[]',
  badges: '[]',
  wins: 10,
  losses: 5,
  mvpCount: 2,
  streak: 1,
  country: 'Togo',
  city: null,
  bio: null,
  joinedAt: new Date(),
  lastActive: new Date(),
  isOnline: false,
  isBanned: false,
  roleUser: 'user',
  provider: 'local',
  googleId: null,
  mlbbRoleId: 1234,
  gameRankLevel: 160,
  gameStats: '{}',
  gameFrequentHeroes: '[]',
  gameRoles: '[]',
  gameSeasons: '[]',
  profileSource: 'game',
  ...over,
});

const appRow = (over: Record<string, any> = {}) => ({
  id: 'app-1',
  recruitmentId: 'rec-1',
  teamId: 'team-1',
  userId: 'u-candidate',
  role: 'jungle',
  message: null,
  status: 'pending',
  availability: 'regular',
  rankLevel: 160,
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const campaignRow = (over: Record<string, any> = {}) => ({
  id: 'rec-1',
  teamId: 'team-1',
  createdById: 'u-captain',
  status: 'open',
  message: null,
  slots: [{ role: 'jungle', quantity: 1 }],
  minRankLevel: null,
  availability: null,
  openedAt: new Date(),
  closedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const CAPTAIN = { id: 'u-captain', roleUser: 'user' };
const CANDIDATE = { id: 'u-candidate', roleUser: 'user' };
const STRANGER = { id: 'u-stranger', roleUser: 'user' };
const ADMIN = { id: 'u-admin', roleUser: 'admin' };

describe('RecruitmentService', () => {
  let service: RecruitmentService;
  let prisma: any;
  let community: { notifyUser: jest.Mock };

  beforeEach(() => {
    prisma = {
      recruitment: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(campaignRow()),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      recruitmentApplication: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(appRow()),
        create: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: any) => ({
          ...appRow(),
          ...data,
        })),
        deleteMany: jest.fn(),
      },
      esportTeam: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'team-1', name: 'Kara Esport' }),
      },
      esportTeamMember: {
        // Only the captain row matches { isCaptain: true }.
        findFirst: jest.fn().mockImplementation(({ where }: any) =>
          where.userId === 'u-captain' ? { id: 'm-1' } : null,
        ),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(userRow()),
      },
    };
    community = { notifyUser: jest.fn().mockResolvedValue(null) };
    service = new RecruitmentService(
      prisma as unknown as PrismaService,
      community as unknown as CommunityService,
    );
  });

  // ----- Campaign filters -----

  describe('listOpen', () => {
    it('only returns open campaigns by default', async () => {
      await service.listOpen();

      expect(prisma.recruitment.findMany).toHaveBeenCalledWith({
        where: { status: 'open' },
        orderBy: { openedAt: 'desc' },
      });
    });

    it('filters on a lane through the slots', async () => {
      await service.listOpen({ role: 'jungle' });

      expect(prisma.recruitment.findMany.mock.calls[0][0].where).toEqual({
        status: 'open',
        slots: { some: { role: 'jungle' } },
      });
    });

    it('keeps the campaigns a player of that rank is eligible for', async () => {
      await service.listOpen({ rankLevel: 160 });

      expect(prisma.recruitment.findMany.mock.calls[0][0].where.AND).toEqual([
        { OR: [{ minRankLevel: null }, { minRankLevel: { lte: 160 } }] },
      ]);
    });

    it('keeps campaigns without an availability expectation when filtering', async () => {
      await service.listOpen({ availability: 'competitive' });

      expect(prisma.recruitment.findMany.mock.calls[0][0].where.AND).toEqual([
        { OR: [{ availability: 'competitive' }, { availability: null }] },
      ]);
    });

    it('combines every filter without one clause dropping another', async () => {
      await service.listOpen({
        role: 'mid',
        rankLevel: 100,
        availability: 'casual',
        status: 'all',
        limit: 5,
      });

      const call = prisma.recruitment.findMany.mock.calls[0][0];
      expect(call.where.status).toBeUndefined(); // status: 'all'
      expect(call.where.slots).toEqual({ some: { role: 'mid' } });
      expect(call.where.AND).toHaveLength(2);
      expect(call.take).toBe(5);
    });

    it('exposes the decoded rank requirement alongside the raw level', async () => {
      prisma.recruitment.findMany.mockResolvedValue([
        campaignRow({ minRankLevel: 160 }),
      ]);
      prisma.esportTeam.findMany.mockResolvedValue([
        { id: 'team-1', name: 'Kara Esport', image: null, type: 'main' },
      ]);

      const [campaign] = await service.listOpen();

      expect(campaign.minRankLevel).toBe(160);
      expect(campaign.minRankLabel).toBe('Mythic');
      expect(campaign.team).toEqual(
        expect.objectContaining({ name: 'Kara Esport' }),
      );
    });
  });

  // ----- Application filters -----

  describe('listApplications', () => {
    it('shows the applications still waiting for an answer by default', async () => {
      await service.listApplications('rec-1', CAPTAIN);

      expect(prisma.recruitmentApplication.findMany.mock.calls[0][0].where).toEqual({
        recruitmentId: 'rec-1',
        status: { in: ['pending', 'shortlisted'] },
      });
    });

    it('filters on status, lane, availability and rank snapshot', async () => {
      await service.listApplications('rec-1', CAPTAIN, {
        status: 'shortlisted',
        role: 'gold',
        availability: 'competitive',
        minRankLevel: 135,
      });

      expect(prisma.recruitmentApplication.findMany.mock.calls[0][0].where).toEqual({
        recruitmentId: 'rec-1',
        status: 'shortlisted',
        role: 'gold',
        availability: 'competitive',
        rankLevel: { gte: 135 },
      });
    });

    it('drops the status clause entirely for status=all', async () => {
      await service.listApplications('rec-1', CAPTAIN, { status: 'all' });

      expect(prisma.recruitmentApplication.findMany.mock.calls[0][0].where).toEqual(
        { recruitmentId: 'rec-1' },
      );
    });

    it('refuses to list a campaign the caller does not manage', async () => {
      await expect(
        service.listApplications('rec-1', STRANGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.recruitmentApplication.findMany).not.toHaveBeenCalled();
    });

    it('404s on an unknown campaign before checking anything else', async () => {
      prisma.recruitment.findUnique.mockResolvedValue(null);

      await expect(
        service.listApplications('nope', CAPTAIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never leaks the candidate credentials or PII', async () => {
      prisma.recruitmentApplication.findMany.mockResolvedValue([appRow()]);
      prisma.user.findMany.mockResolvedValue([userRow()]);

      const [application] = await service.listApplications('rec-1', CAPTAIN);

      expect(application.user.password).toBeUndefined();
      expect(application.user.email).toBeUndefined();
      expect(application.user.mlbbToken).toBeUndefined();
      expect(application.user.googleId).toBeUndefined();
      // ...but the enriched profile the recruiter needs is there.
      expect(application.user.username).toBe('candidate');
      expect(application.user.winRate).toBe(66.7);
      expect(application.user.gameRank).toBe('Mythic');
      expect(application.rankLabel).toBe('Mythic');
    });
  });

  describe('listTeamApplications', () => {
    it('is reserved to the team owner', async () => {
      await expect(
        service.listTeamApplications('team-1', STRANGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('spans every campaign of the team', async () => {
      await service.listTeamApplications('team-1', CAPTAIN, { status: 'all' });

      expect(prisma.recruitmentApplication.findMany.mock.calls[0][0].where).toEqual(
        { teamId: 'team-1' },
      );
    });
  });

  describe('myApplications', () => {
    it('filters on the caller and tells the UI what can still be withdrawn', async () => {
      prisma.recruitmentApplication.findMany.mockResolvedValue([
        appRow({ id: 'a1', status: 'pending' }),
        appRow({ id: 'a2', status: 'rejected' }),
      ]);
      prisma.recruitment.findMany.mockResolvedValue([campaignRow()]);

      const res = await service.myApplications('u-candidate', { status: 'all' });

      expect(prisma.recruitmentApplication.findMany.mock.calls[0][0].where).toEqual({
        userId: 'u-candidate',
      });
      expect(res.map((a: any) => a.canWithdraw)).toEqual([true, false]);
      expect(res[0].recruitment).toEqual(
        expect.objectContaining({ id: 'rec-1', status: 'open' }),
      );
    });
  });

  // ----- Status transitions -----

  describe('updateApplicationStatus', () => {
    it('lets the team owner shortlist a pending application', async () => {
      const res = await service.updateApplicationStatus('app-1', CAPTAIN, {
        status: 'shortlisted',
      });

      expect(res.status).toBe('shortlisted');
      expect(prisma.recruitmentApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'app-1' },
          data: expect.objectContaining({
            status: 'shortlisted',
            decidedById: 'u-captain',
          }),
        }),
      );
    });

    it('adds the player to the roster when accepting', async () => {
      prisma.recruitmentApplication.findUnique.mockResolvedValue(
        appRow({ status: 'shortlisted' }),
      );

      await service.updateApplicationStatus('app-1', CAPTAIN, {
        status: 'accepted',
      });

      expect(prisma.esportTeamMember.create).toHaveBeenCalledWith({
        data: { teamId: 'team-1', userId: 'u-candidate', role: 'jungle' },
      });
    });

    it('does not duplicate an existing roster entry', async () => {
      prisma.esportTeamMember.findUnique.mockResolvedValue({ id: 'm-9' });

      await service.updateApplicationStatus('app-1', CAPTAIN, {
        status: 'accepted',
      });

      expect(prisma.esportTeamMember.create).not.toHaveBeenCalled();
    });

    it('lets the staff act on any team', async () => {
      const res = await service.updateApplicationStatus('app-1', ADMIN, {
        status: 'rejected',
      });

      expect(res.status).toBe('rejected');
    });

    it('refuses a transition out of a terminal status', async () => {
      prisma.recruitmentApplication.findUnique.mockResolvedValue(
        appRow({ status: 'accepted' }),
      );

      await expect(
        service.updateApplicationStatus('app-1', CAPTAIN, { status: 'rejected' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.recruitmentApplication.update).not.toHaveBeenCalled();
    });

    it('refuses to un-withdraw an application', async () => {
      prisma.recruitmentApplication.findUnique.mockResolvedValue(
        appRow({ status: 'withdrawn' }),
      );

      await expect(
        service.updateApplicationStatus('app-1', CAPTAIN, {
          status: 'shortlisted',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to shortlist an application that is already shortlisted', async () => {
      prisma.recruitmentApplication.findUnique.mockResolvedValue(
        appRow({ status: 'shortlisted' }),
      );

      await expect(
        service.updateApplicationStatus('app-1', CAPTAIN, {
          status: 'shortlisted',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a status that is not part of the life cycle', async () => {
      await expect(
        service.updateApplicationStatus('app-1', CAPTAIN, {
          status: 'pending' as any,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s on an unknown application', async () => {
      prisma.recruitmentApplication.findUnique.mockResolvedValue(null);

      await expect(
        service.updateApplicationStatus('nope', CAPTAIN, { status: 'rejected' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ----- Authorisation -----

  describe('authorisation', () => {
    it('forbids a third party from changing a status', async () => {
      await expect(
        service.updateApplicationStatus('app-1', STRANGER, {
          status: 'accepted',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.recruitmentApplication.update).not.toHaveBeenCalled();
      expect(community.notifyUser).not.toHaveBeenCalled();
    });

    it('forbids the candidate from accepting their own application', async () => {
      await expect(
        service.updateApplicationStatus('app-1', CANDIDATE, {
          status: 'accepted',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.esportTeamMember.create).not.toHaveBeenCalled();
    });

    it('lets the candidate withdraw their own application', async () => {
      const res = await service.updateApplicationStatus('app-1', CANDIDATE, {
        status: 'withdrawn',
      });

      expect(res.status).toBe('withdrawn');
    });

    it('forbids a third party from withdrawing somebody else application', async () => {
      await expect(
        service.updateApplicationStatus('app-1', STRANGER, {
          status: 'withdrawn',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.recruitmentApplication.update).not.toHaveBeenCalled();
    });

    it('forbids the team owner from withdrawing a candidate application', async () => {
      await expect(
        service.updateApplicationStatus('app-1', CAPTAIN, {
          status: 'withdrawn',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('forbids even the staff from withdrawing on behalf of a candidate', async () => {
      await expect(
        service.updateApplicationStatus('app-1', ADMIN, { status: 'withdrawn' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('checks the caller before the transition table', async () => {
      // Terminal status + a stranger: the answer must be 403, never a 409 that
      // would reveal the state of somebody else's application.
      prisma.recruitmentApplication.findUnique.mockResolvedValue(
        appRow({ status: 'accepted' }),
      );

      await expect(
        service.updateApplicationStatus('app-1', STRANGER, {
          status: 'rejected',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ----- Notifications -----

  describe('notifications', () => {
    it('notifies the candidate on every recruiter decision', async () => {
      await service.updateApplicationStatus('app-1', CAPTAIN, {
        status: 'shortlisted',
        note: 'On te teste vendredi',
      });

      expect(community.notifyUser).toHaveBeenCalledWith(
        'u-candidate',
        expect.objectContaining({
          type: 'recruitment_decision',
          title: 'Candidature présélectionnée',
          message: expect.stringContaining('On te teste vendredi'),
        }),
      );
    });

    it('notifies the campaign owner when a candidate withdraws', async () => {
      await service.updateApplicationStatus('app-1', CANDIDATE, {
        status: 'withdrawn',
      });

      expect(community.notifyUser).toHaveBeenCalledWith(
        'u-captain',
        expect.objectContaining({ type: 'recruitment_application' }),
      );
    });
  });

  // ----- Applying -----

  describe('apply', () => {
    it('stores the availability and the rank snapshot', async () => {
      await service.apply(CANDIDATE, 'rec-1', {
        role: 'jungle',
        availability: 'competitive',
      });

      expect(prisma.recruitmentApplication.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          availability: 'competitive',
          rankLevel: 160,
          role: 'jungle',
        }),
      });
    });

    it('turns down a candidate below the advertised rank requirement', async () => {
      prisma.recruitment.findUnique.mockResolvedValue(
        campaignRow({ minRankLevel: 200 }),
      );

      await expect(
        service.apply(CANDIDATE, 'rec-1', { role: 'jungle' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.recruitmentApplication.create).not.toHaveBeenCalled();
    });

    it('only blocks a second application while the first is still active', async () => {
      await service.apply(CANDIDATE, 'rec-1', {});

      expect(prisma.recruitmentApplication.findFirst).toHaveBeenCalledWith({
        where: {
          recruitmentId: 'rec-1',
          userId: 'u-candidate',
          status: { in: ['pending', 'shortlisted'] },
        },
      });
    });

    it('refuses a lane the campaign did not open', async () => {
      await expect(
        service.apply(CANDIDATE, 'rec-1', { role: 'roam' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a closed campaign', async () => {
      prisma.recruitment.findUnique.mockResolvedValue(
        campaignRow({ status: 'closed' }),
      );

      await expect(service.apply(CANDIDATE, 'rec-1', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
