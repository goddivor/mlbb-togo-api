import { CommunityService } from './community.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { PushService } from '../push/push.service';

const ME = 'me';
const SOMEONE_ELSE = 'other';

/** Minimal notification row, shaped like what Prisma returns. */
const notif = (over: Partial<Record<string, any>> = {}) => ({
  id: 'n1',
  userId: ME,
  type: 'message',
  title: 'Titre',
  message: 'Message',
  data: null,
  read: false,
  link: null,
  createdAt: new Date(),
  ...over,
});

describe('CommunityService notifications', () => {
  let service: CommunityService;
  let prisma: {
    notification: {
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new CommunityService(
      prisma as unknown as PrismaService,
      { emitToUser: jest.fn() } as unknown as ChatGateway,
      { sendToUser: jest.fn() } as unknown as PushService,
    );
  });

  describe('listNotifications', () => {
    it('defaults to the first page of 20, newest first, scoped to the user', async () => {
      prisma.notification.findMany.mockResolvedValue([notif()]);
      prisma.notification.count.mockResolvedValue(1);

      const res = await service.listNotifications(ME);

      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: { userId: ME },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(res.page).toBe(1);
      expect(res.limit).toBe(20);
      expect(res.items).toHaveLength(1);
    });

    it('translates page/limit into skip/take and reports the page count', async () => {
      prisma.notification.count.mockResolvedValue(47);

      const res = await service.listNotifications(ME, { page: 3, limit: 10 });

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(res.total).toBe(47);
      expect(res.pages).toBe(5);
    });

    it('keeps at least one page when the mailbox is empty', async () => {
      prisma.notification.count.mockResolvedValue(0);

      const res = await service.listNotifications(ME);

      expect(res.total).toBe(0);
      expect(res.pages).toBe(1);
      expect(res.items).toEqual([]);
    });

    it('filters by type at the query level', async () => {
      await service.listNotifications(ME, { type: 'friend_request' });

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: ME, type: 'friend_request' },
        }),
      );
    });

    it('filters by read state', async () => {
      await service.listNotifications(ME, { status: 'unread' });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: ME, read: false } }),
      );

      prisma.notification.findMany.mockClear();
      await service.listNotifications(ME, { status: 'read' });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: ME, read: true } }),
      );
    });

    it('ignores the read filter when status is "all"', async () => {
      await service.listNotifications(ME, { status: 'all' });

      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: ME } }),
      );
    });

    it('exposes per-type counts computed over the whole mailbox', async () => {
      prisma.notification.groupBy.mockResolvedValue([
        { type: 'message', _count: { _all: 4 } },
        { type: 'friend_request', _count: { _all: 2 } },
      ]);

      const res = await service.listNotifications(ME, { type: 'message' });

      // The facet ignores the type filter, otherwise selecting a chip would
      // hide every other chip from the UI.
      expect(prisma.notification.groupBy).toHaveBeenCalledWith({
        by: ['type'],
        where: { userId: ME },
        _count: { _all: true },
      });
      expect(res.counts).toEqual({ message: 4, friend_request: 2 });
    });

    it('reports the unread total regardless of the active filters', async () => {
      prisma.notification.count.mockImplementation(({ where }: any) =>
        Promise.resolve(where.read === false ? 7 : 30),
      );

      const res = await service.listNotifications(ME, { status: 'read' });

      expect(res.unread).toBe(7);
      expect(res.total).toBe(30);
    });

    it('never lets a caller page through somebody else\'s mailbox', async () => {
      await service.listNotifications(ME, {
        // A crafted query cannot smuggle another owner in: userId is an
        // argument taken from the JWT, not a query field.
        type: 'message',
        page: 1,
      } as any);

      const calls = [
        ...prisma.notification.findMany.mock.calls,
        ...prisma.notification.count.mock.calls,
        ...prisma.notification.groupBy.mock.calls,
      ];
      expect(calls).not.toHaveLength(0);
      for (const [args] of calls) {
        expect(args.where.userId).toBe(ME);
        expect(args.where.userId).not.toBe(SOMEONE_ELSE);
      }
    });
  });

  describe('markRead', () => {
    it('scopes the update to the owner so a foreign id matches nothing', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });

      const res = await service.markRead(ME, 'notif-of-other');

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'notif-of-other', userId: ME },
        data: { read: true },
      });
      expect(res).toEqual({ ok: true, updated: 0 });
    });

    it('reports how many rows it flipped', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });

      expect(await service.markRead(ME, 'n1')).toEqual({
        ok: true,
        updated: 1,
      });
    });
  });

  describe('markAllRead', () => {
    it('only touches the unread notifications of the current user', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 3 });

      const res = await service.markAllRead(ME);

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: ME, read: false },
        data: { read: true },
      });
      expect(res).toEqual({ ok: true, updated: 3 });
    });

    it('narrows to the displayed type when one is given', async () => {
      await service.markAllRead(ME, 'message');

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: ME, read: false, type: 'message' },
        data: { read: true },
      });
    });

    it('never writes outside the current user', async () => {
      await service.markAllRead(ME, 'message');

      const [[args]] = prisma.notification.updateMany.mock.calls;
      expect(args.where.userId).toBe(ME);
      expect(args.where.userId).not.toBe(SOMEONE_ELSE);
    });
  });

  describe('unreadCount', () => {
    it('counts only the unread rows of the current user', async () => {
      prisma.notification.count.mockResolvedValue(5);

      expect(await service.unreadCount(ME)).toEqual({ count: 5 });
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { userId: ME, read: false },
      });
    });
  });
});
