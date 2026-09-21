import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { POST_CATEGORIES } from './posts.constants';

@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  /** Legacy flat list (array). Supports the same category/sort filters. */
  @Get()
  findAll(@Query('category') category?: string, @Query('sort') sort?: string) {
    return this.postsService.findAll(category, sort);
  }

  /** Paginated feed: `{ items, total, page, limit, hasMore }`. */
  @Get('feed')
  feed(@Query() query: ListPostsDto) {
    return this.postsService.feed(query);
  }

  /** Category enum + per-category counters. */
  @Get('categories')
  async categories() {
    const counts = await this.postsService.categoryCounts();
    return { categories: POST_CATEGORIES, counts };
  }

  /** IDs of the posts liked by the current user. */
  @UseGuards(JwtAuthGuard)
  @Get('liked')
  liked(@CurrentUser() user: any) {
    return this.postsService.likedPostIds(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.postsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Body() dto: CreatePostDto, @CurrentUser() user: any) {
    return this.postsService.create(dto, user);
  }

  /** Admin/moderator: pin, mark sponsored, attach a sponsor. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
    @CurrentUser() user: any,
  ) {
    return this.postsService.update(id, dto, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.postsService.remove(id, user);
  }

  /** Toggle like for the current user: `{ liked, likes }`. */
  @UseGuards(JwtAuthGuard)
  @Post(':id/like')
  like(@Param('id') id: string, @CurrentUser() user: any) {
    return this.postsService.toggleLike(id, user);
  }

  /** Public share counter: `{ shares }`. */
  @Post(':id/share')
  share(@Param('id') id: string) {
    return this.postsService.share(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: any,
  ) {
    return this.postsService.addComment(id, dto, user);
  }
}
