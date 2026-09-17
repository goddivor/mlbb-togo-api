import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PostsService,
  canPostInCategory,
  categoryWhere,
  parseImages,
  serializePost,
  sortOrderBy,
} from './posts.service';
import { PrismaService } from '../prisma/prisma.service';

const postRow = (over: Record<string, any> = {}) => ({
  id: 'p1',
  authorId: 'u1',
  authorName: 'TogoKing',
  authorRank: 'mythic',
  category: 'community',
  title: 'Hello',
  content: 'World',
  likes: 0,
  views: 0,
  shares: 0,
  isPinned: false,
  contentFormat: 'text',
  images: '[]',
  isSponsored: false,
  sponsorId: null,
  comments: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const admin = { id: 'a1', username: 'admin', roleUser: 'admin' };
const moderator = { id: 'm1', username: 'mod', roleUser: 'moderator' };
const player = { id: 'u1', username: 'player', roleUser: 'user' };

function makePrisma() {
  return {
    post: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    postLike: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    comment: { create: jest.fn(), deleteMany: jest.fn() },
    sponsor: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
  };
}

describe('posts pure rules', () => {
  it('restricts announcement/stream to staff', () => {
    expect(canPostInCategory('announcement', admin)).toBe(true);
    expect(canPostInCategory('stream', moderator)).toBe(true);
    expect(canPostInCategory('announcement', player)).toBe(false);
    expect(canPostInCategory('stream', undefined)).toBe(false);
    expect(canPostInCategory('offline', player)).toBe(true);
    expect(canPostInCategory('community', player)).toBe(true);
    expect(canPostInCategory('strategies', admin)).toBe(false);
  });

  it('folds legacy categories into community', () => {
    expect(categoryWhere(undefined)).toBeUndefined();
    expect(categoryWhere('all')).toBeUndefined();
    expect(categoryWhere('stream')).toEqual({ category: 'stream' });
    expect(categoryWhere('community')).toEqual({
      category: { notIn: ['announcement', 'stream', 'offline'] },
    });
  });

  it('maps sort keys to Prisma orderBy (pinned first by default)', () => {
    expect(sortOrderBy(undefined)).toEqual([
      { isPinned: 'desc' },
      { createdAt: 'desc' },
    ]);
    expect(sortOrderBy('latest')).toEqual([{ createdAt: 'desc' }]);
    expect(sortOrderBy('popular')[0]).toEqual({ likes: 'desc' });
  });

  it('parses images defensively', () => {
    expect(parseImages(null)).toEqual([]);
    expect(parseImages('not json')).toEqual([]);
    expect(parseImages('["https://a/b.png", 3]')).toEqual(['https://a/b.png']);
    const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => `u${i}`));
    expect(parseImages(many)).toHaveLength(6);
  });

  it('serializes sponsor only when the post is flagged sponsored', () => {
    const sponsor = { id: 's1', name: 'Moov', logo: '/l.png', url: null };
    expect(serializePost(postRow({ sponsorId: 's1' }), sponsor).sponsor).toBeNull();
    const out = serializePost(
      postRow({ sponsorId: 's1', isSponsored: true, comments: [{}, {}] }),
      sponsor,
      true,
    );
    expect(out.sponsor).toEqual(sponsor);
    expect(out.commentCount).toBe(2);
    expect(out.likedByMe).toBe(true);
    expect(out.postLikes).toBeUndefined();
  });
});

describe('PostsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: PostsService;
  const gamification = { trackSafe: jest.fn().mockResolvedValue(null) };

  beforeEach(() => {
    prisma = makePrisma();
    service = new PostsService(
      prisma as unknown as PrismaService,
      gamification as any,
    );
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('rejects announcement from a regular user', async () => {
      await expect(
        service.create(
          { category: 'announcement', title: 't', content: 'c' } as any,
          player,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('lets an admin post an announcement and tracks XP', async () => {
      prisma.post.create.mockResolvedValue(
        postRow({ category: 'announcement', authorId: 'a1' }),
      );
      const out = await service.create(
        {
          category: 'announcement',
          title: 't',
          content: '**c**',
          contentFormat: 'markdown',
          images: ['https://x/1.png'],
        } as any,
        admin,
      );
      expect(prisma.post.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authorId: 'a1',
            authorName: 'admin',
            contentFormat: 'markdown',
            images: JSON.stringify(['https://x/1.png']),
            isSponsored: false,
          }),
        }),
      );
      expect(gamification.trackSafe).toHaveBeenCalledWith('a1', 'forum_post', 'p1');
      expect(out.images).toEqual([]);
    });

    it('refuses sponsoring from a regular user', async () => {
      await expect(
        service.create(
          { category: 'community', title: 't', content: 'c', isSponsored: true } as any,
          player,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('attaches the sponsor for an admin and marks the post sponsored', async () => {
      prisma.sponsor.findUnique.mockResolvedValue({ id: 's1' });
      prisma.post.create.mockResolvedValue(
        postRow({ isSponsored: true, sponsorId: 's1' }),
      );
      prisma.sponsor.findMany.mockResolvedValue([
        { id: 's1', name: 'Moov', logo: '/l.png', url: null },
      ]);
      const out = await service.create(
        { category: 'community', title: 't', content: 'c', sponsorId: 's1' } as any,
        admin,
      );
      expect(prisma.post.create.mock.calls[0][0].data).toMatchObject({
        isSponsored: true,
        sponsorId: 's1',
      });
      expect(out.sponsor).toEqual({ id: 's1', name: 'Moov', logo: '/l.png', url: null });
    });
  });

  describe('toggleLike', () => {
    it('likes then unlikes idempotently and keeps the counter in sync', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow({ likes: 0 }));
      prisma.postLike.findUnique.mockResolvedValueOnce(null);
      prisma.post.update.mockResolvedValueOnce({ likes: 1 });
      const first = await service.toggleLike('p1', player);
      expect(first).toEqual({ liked: true, likes: 1 });
      expect(prisma.postLike.create).toHaveBeenCalledWith({
        data: { postId: 'p1', userId: 'u1' },
      });
      expect(prisma.post.update).toHaveBeenLastCalledWith({
        where: { id: 'p1' },
        data: { likes: { increment: 1 } },
        select: { likes: true },
      });

      prisma.post.findUnique.mockResolvedValue(postRow({ likes: 1 }));
      prisma.postLike.findUnique.mockResolvedValueOnce({ id: 'l1' });
      prisma.postLike.deleteMany.mockResolvedValueOnce({ count: 1 });
      prisma.post.update.mockResolvedValueOnce({ likes: 0 });
      const second = await service.toggleLike('p1', player);
      expect(second).toEqual({ liked: false, likes: 0 });
      expect(prisma.postLike.deleteMany).toHaveBeenCalledWith({
        where: { postId: 'p1', userId: 'u1' },
      });
      expect(prisma.postLike.create).toHaveBeenCalledTimes(1);
      expect(prisma.post.update).toHaveBeenLastCalledWith({
        where: { id: 'p1' },
        data: { likes: { increment: -1 } },
        select: { likes: true },
      });
    });

    it('treats a concurrent duplicate like (P2002) as already liked without counting twice', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow({ likes: 1 }));
      prisma.postLike.findUnique.mockResolvedValueOnce(null);
      prisma.postLike.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(service.toggleLike('p1', player)).resolves.toEqual({
        liked: true,
        likes: 1,
      });
      expect(prisma.post.update).not.toHaveBeenCalled();
    });

    it('does not decrement when a concurrent request already removed the like', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow({ likes: 0 }));
      prisma.postLike.findUnique.mockResolvedValueOnce({ id: 'l1' });
      prisma.postLike.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.toggleLike('p1', player)).resolves.toEqual({
        liked: false,
        likes: 0,
      });
      expect(prisma.post.update).not.toHaveBeenCalled();
    });

    it('rethrows unexpected errors from the like insert', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow());
      prisma.postLike.findUnique.mockResolvedValueOnce(null);
      prisma.postLike.create.mockRejectedValueOnce(new Error('boom'));
      await expect(service.toggleLike('p1', player)).rejects.toThrow('boom');
    });

    it('never reports a counter below zero', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow({ likes: 0 }));
      prisma.postLike.findUnique.mockResolvedValue({ id: 'l1' });
      prisma.postLike.deleteMany.mockResolvedValueOnce({ count: 1 });
      prisma.post.update.mockResolvedValueOnce({ likes: -1 });
      const res = await service.toggleLike('p1', player);
      expect(res).toEqual({ liked: false, likes: 0 });
    });
  });

  describe('feed / sorting', () => {
    it('paginates and applies the requested sort', async () => {
      prisma.post.count.mockResolvedValue(25);
      prisma.post.findMany.mockResolvedValue([postRow()]);
      const out = await service.feed({ sort: 'popular', page: 2, limit: 10 });
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
          orderBy: sortOrderBy('popular'),
        }),
      );
      expect(out).toMatchObject({ total: 25, page: 2, limit: 10, hasMore: true });
      expect(out.items[0].commentCount).toBe(0);
    });

    it('returns counters for every enum category', async () => {
      prisma.post.count.mockResolvedValue(3);
      const counts = await service.categoryCounts();
      expect(Object.keys(counts)).toEqual([
        'all',
        'announcement',
        'stream',
        'offline',
        'community',
      ]);
    });
  });

  describe('update / remove', () => {
    it('only staff may pin', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow());
      await expect(
        service.update('p1', { isPinned: true }, player),
      ).rejects.toBeInstanceOf(ForbiddenException);
      prisma.post.update.mockResolvedValue(postRow({ isPinned: true }));
      const out = await service.update('p1', { isPinned: true }, moderator);
      expect(out.isPinned).toBe(true);
    });

    it('unmarking sponsored detaches the sponsor', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow({ isSponsored: true, sponsorId: 's1' }));
      prisma.post.update.mockResolvedValue(postRow());
      await service.update('p1', { isSponsored: false }, admin);
      expect(prisma.post.update.mock.calls[0][0].data).toEqual({
        isSponsored: false,
        sponsorId: null,
      });
    });

    it('share increments the counter', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow());
      prisma.post.update.mockResolvedValue(postRow({ shares: 4 }));
      expect(await service.share('p1')).toEqual({ shares: 4 });
    });

    it('remove cleans likes and comments', async () => {
      prisma.post.findUnique.mockResolvedValue(postRow({ authorId: 'u1' }));
      await service.remove('p1', player);
      expect(prisma.postLike.deleteMany).toHaveBeenCalledWith({ where: { postId: 'p1' } });
      expect(prisma.post.delete).toHaveBeenCalled();
    });
  });
});
