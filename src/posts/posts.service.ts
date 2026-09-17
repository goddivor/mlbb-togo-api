import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';
import { GamificationService } from '../gamification/gamification.service';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_POST_IMAGES,
  POST_CATEGORIES,
  PostCategory,
  PostSort,
  STAFF_ONLY_CATEGORIES,
  STAFF_ROLES,
} from './posts.constants';

type ActingUser = { id?: string; username?: string; roleUser?: string };

const NON_COMMUNITY: string[] = POST_CATEGORIES.filter(
  (c) => c !== 'community',
);

/** Pure helpers: exported so the sorting / permission rules are unit-testable. */
export function isStaff(user?: ActingUser | null): boolean {
  return STAFF_ROLES.includes(user?.roleUser ?? '');
}

export function canPostInCategory(
  category: string,
  user?: ActingUser | null,
): boolean {
  if (!(POST_CATEGORIES as readonly string[]).includes(category)) return false;
  if (STAFF_ONLY_CATEGORIES.includes(category as PostCategory)) {
    return isStaff(user);
  }
  return true;
}

/**
 * Prisma `where` for a feed category. Legacy categories (strategies, guides…)
 * created before the enum existed are folded into `community` so they stay
 * visible and the tab counters add up to the total.
 */
export function categoryWhere(
  category?: string | null,
): Prisma.PostWhereInput | undefined {
  if (!category || category === 'all') return undefined;
  if (category === 'community') return { category: { notIn: NON_COMMUNITY } };
  return { category };
}

export function sortOrderBy(
  sort?: string | null,
): Prisma.PostOrderByWithRelationInput[] {
  switch ((sort ?? 'pinned') as PostSort) {
    case 'latest':
      return [{ createdAt: 'desc' }];
    case 'popular':
      return [{ likes: 'desc' }, { views: 'desc' }, { createdAt: 'desc' }];
    case 'pinned':
    default:
      return [{ isPinned: 'desc' }, { createdAt: 'desc' }];
  }
}

export function parseImages(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((u) => typeof u === 'string').slice(0, MAX_POST_IMAGES)
      : [];
  } catch {
    return [];
  }
}

/** Public shape of a post: parsed JSON fields + sponsor + comment count. */
export function serializePost(
  post: any,
  sponsor?: { id: string; name: string | null; logo: string; url: string | null } | null,
  likedByMe?: boolean,
) {
  if (!post) return post;
  const { postLikes: _likes, ...rest } = post;
  const comments = Array.isArray(post.comments) ? post.comments : [];
  return {
    ...rest,
    images: parseImages(post.images),
    commentCount: comments.length,
    sponsor: post.isSponsored && sponsor ? sponsor : null,
    ...(likedByMe !== undefined ? { likedByMe } : {}),
  };
}

@Injectable()
export class PostsService {
  constructor(
    private prisma: PrismaService,
    @Optional() private gamification?: GamificationService,
  ) {}

  /** Attach sponsor info to a list of raw posts in one query. */
  private async withSponsors(posts: any[]) {
    const ids = Array.from(
      new Set(
        posts
          .filter((p) => p.isSponsored && p.sponsorId)
          .map((p) => p.sponsorId as string),
      ),
    );
    const sponsors = ids.length
      ? await this.prisma.sponsor.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, logo: true, url: true },
        })
      : [];
    const byId = new Map(sponsors.map((s) => [s.id, s]));
    return posts.map((p) =>
      serializePost(p, p.sponsorId ? byId.get(p.sponsorId) : null),
    );
  }

  private async findRaw(id: string) {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Post introuvable.');
    return post;
  }

  /** Legacy list endpoint: plain array, kept for backward compatibility. */
  async findAll(category?: string, sort?: string) {
    const posts = await this.prisma.post.findMany({
      where: categoryWhere(category),
      include: { comments: true },
      orderBy: sortOrderBy(sort),
    });
    return this.withSponsors(posts);
  }

  /** Paginated feed used by the Communication page. */
  async feed(query: ListPostsDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where = categoryWhere(query.category);
    const [total, posts] = await Promise.all([
      this.prisma.post.count({ where }),
      this.prisma.post.findMany({
        where,
        include: { comments: true },
        orderBy: sortOrderBy(query.sort),
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      items: await this.withSponsors(posts),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    };
  }

  /** Per-category counters (legacy categories counted under `community`). */
  async categoryCounts() {
    const [all, ...perCategory] = await Promise.all([
      this.prisma.post.count(),
      ...POST_CATEGORIES.map((c) =>
        this.prisma.post.count({ where: categoryWhere(c) }),
      ),
    ]);
    const counts: Record<string, number> = { all };
    POST_CATEGORIES.forEach((c, i) => {
      counts[c] = perCategory[i];
    });
    return counts;
  }

  /** IDs of the posts liked by the current user (for the feed UI). */
  async likedPostIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.postLike.findMany({
      where: { userId },
      select: { postId: true },
    });
    return rows.map((r) => r.postId);
  }

  async findOne(id: string, viewer?: ActingUser) {
    await this.findRaw(id);
    const post = await this.prisma.post.update({
      where: { id },
      data: { views: { increment: 1 } },
      include: { comments: true },
    });
    const [serialized] = await this.withSponsors([post]);
    if (viewer?.id) {
      const like = await this.prisma.postLike.findUnique({
        where: { postId_userId: { postId: id, userId: viewer.id } },
      });
      return { ...serialized, likedByMe: !!like };
    }
    return serialized;
  }

  private async resolveSponsor(
    dto: { isSponsored?: boolean; sponsorId?: string | null },
    user?: ActingUser,
  ): Promise<{ isSponsored?: boolean; sponsorId?: string | null }> {
    if (dto.isSponsored === undefined && dto.sponsorId === undefined) return {};
    if (!isStaff(user)) {
      throw new ForbiddenException(
        'Seuls les administrateurs peuvent sponsoriser un post.',
      );
    }
    const out: { isSponsored?: boolean; sponsorId?: string | null } = {};
    if (dto.sponsorId !== undefined) {
      if (dto.sponsorId) {
        const sponsor = await this.prisma.sponsor.findUnique({
          where: { id: dto.sponsorId },
        });
        if (!sponsor) throw new BadRequestException('Sponsor introuvable.');
      }
      out.sponsorId = dto.sponsorId || null;
    }
    if (dto.isSponsored !== undefined) out.isSponsored = dto.isSponsored;
    // Attaching a sponsor implies the sponsored flag unless explicitly unset.
    if (out.sponsorId && dto.isSponsored === undefined) out.isSponsored = true;
    if (out.isSponsored === false && dto.sponsorId === undefined) {
      out.sponsorId = null;
    }
    return out;
  }

  async create(dto: CreatePostDto, user?: ActingUser) {
    if (!canPostInCategory(dto.category, user)) {
      throw new ForbiddenException(
        'Seuls les administrateurs et modérateurs peuvent publier dans cette catégorie.',
      );
    }
    const authorId = user?.id ?? dto.authorId;
    const authorName = user?.username ?? dto.authorName;
    if (!authorId || !authorName) {
      throw new BadRequestException('Auteur requis.');
    }
    const sponsoring = await this.resolveSponsor(dto, user);
    const post = await this.prisma.post.create({
      data: {
        authorId,
        authorName,
        authorRank: dto.authorRank,
        category: dto.category,
        title: dto.title,
        content: dto.content,
        contentFormat: dto.contentFormat ?? 'text',
        images: JSON.stringify((dto.images ?? []).slice(0, MAX_POST_IMAGES)),
        isSponsored: sponsoring.isSponsored ?? false,
        sponsorId: sponsoring.sponsorId ?? null,
      },
      include: { comments: true },
    });
    void this.gamification?.trackSafe(authorId, 'forum_post', post.id);
    const [serialized] = await this.withSponsors([post]);
    return serialized;
  }

  /** Admin/moderator moderation: pin, sponsor. */
  async update(id: string, dto: UpdatePostDto, user?: ActingUser) {
    await this.findRaw(id);
    if (!isStaff(user)) {
      throw new ForbiddenException('Action réservée aux administrateurs.');
    }
    const sponsoring = await this.resolveSponsor(dto, user);
    const post = await this.prisma.post.update({
      where: { id },
      data: {
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
        ...sponsoring,
      },
      include: { comments: true },
    });
    const [serialized] = await this.withSponsors([post]);
    return serialized;
  }

  async remove(id: string, user?: ActingUser) {
    const post = await this.findRaw(id);
    if (post.authorId !== user?.id && !isStaff(user)) {
      throw new ForbiddenException('Suppression non autorisée.');
    }
    await this.prisma.comment.deleteMany({ where: { postId: id } });
    await this.prisma.postLike.deleteMany({ where: { postId: id } });
    await this.prisma.post.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Idempotent like toggle: one PostLike row per (post, user); the
   * denormalized `likes` counter never drops below zero.
   */
  async toggleLike(id: string, user: ActingUser) {
    const post = await this.findRaw(id);
    if (!user?.id) throw new ForbiddenException('Connexion requise.');
    const key = { postId_userId: { postId: id, userId: user.id } };
    const existing = await this.prisma.postLike.findUnique({ where: key });
    if (existing) {
      await this.prisma.postLike.delete({ where: key });
      const updated = await this.prisma.post.update({
        where: { id },
        data: { likes: Math.max(0, post.likes - 1) },
      });
      return { liked: false, likes: updated.likes };
    }
    await this.prisma.postLike.create({
      data: { postId: id, userId: user.id },
    });
    const updated = await this.prisma.post.update({
      where: { id },
      data: { likes: { increment: 1 } },
    });
    return { liked: true, likes: updated.likes };
  }

  async share(id: string) {
    await this.findRaw(id);
    const updated = await this.prisma.post.update({
      where: { id },
      data: { shares: { increment: 1 } },
    });
    return { shares: updated.shares };
  }

  async addComment(id: string, dto: CreateCommentDto, user?: ActingUser) {
    await this.findRaw(id);
    const authorId = user?.id ?? dto.authorId;
    const authorName = user?.username ?? dto.authorName;
    await this.prisma.comment.create({
      data: {
        postId: id,
        authorId: authorId as string,
        authorName,
        content: dto.content,
      },
    });
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: { comments: true },
    });
    const [serialized] = await this.withSponsors([post]);
    return serialized;
  }
}
