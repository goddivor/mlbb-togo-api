import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';

const STAFF_ROLES = ['admin', 'moderator'];

@Injectable()
export class PostsService {
  constructor(private prisma: PrismaService) {}

  async findAll(category?: string) {
    return this.prisma.post.findMany({
      where: category ? { category } : undefined,
      include: { comments: true },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: string) {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Post introuvable.');
    return this.prisma.post.update({
      where: { id },
      data: { views: { increment: 1 } },
      include: { comments: true },
    });
  }

  async create(dto: CreatePostDto, user?: { id?: string; username?: string }) {
    const authorId = user?.id ?? dto.authorId;
    const authorName = user?.username ?? dto.authorName;
    return this.prisma.post.create({
      data: {
        authorId: authorId as string,
        authorName,
        authorRank: dto.authorRank,
        category: dto.category,
        title: dto.title,
        content: dto.content,
      },
      include: { comments: true },
    });
  }

  async remove(id: string, user?: { id?: string; roleUser?: string }) {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Post introuvable.');
    const isStaff = STAFF_ROLES.includes(user?.roleUser ?? '');
    if (post.authorId !== user?.id && !isStaff) {
      throw new ForbiddenException('Suppression non autorisée.');
    }
    await this.prisma.comment.deleteMany({ where: { postId: id } });
    await this.prisma.post.delete({ where: { id } });
    return { success: true };
  }

  async like(id: string) {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Post introuvable.');
    return this.prisma.post.update({
      where: { id },
      data: { likes: { increment: 1 } },
      include: { comments: true },
    });
  }

  async addComment(
    id: string,
    dto: CreateCommentDto,
    user?: { id?: string; username?: string },
  ) {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('Post introuvable.');
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
    return this.prisma.post.findUnique({
      where: { id },
      include: { comments: true },
    });
  }
}
