import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalJwtGuard } from '../game/optional-jwt.guard';
import { CommunityBuildsService } from './community-builds.service';
import {
  CreateCommunityBuildDto,
  ReportCommunityBuildDto,
  UpdateCommunityBuildDto,
} from './dto/community-build.dto';

/**
 * Community builds (#129). Public reads resolve the viewer when a token is
 * sent (likedByMe, own drafts); every write requires a signed-in player and
 * owner-only writes are checked in the service.
 */
@Controller('community-builds')
export class CommunityBuildsController {
  constructor(private readonly builds: CommunityBuildsService) {}

  // Published builds. hero = Mongo id or Moonton hero id; lane = gold|exp|jungle|mid|roam;
  // sort = likes (default) | recent; page / limit (max 50).
  @UseGuards(OptionalJwtGuard)
  @Get()
  list(
    @CurrentUser() user: any,
    @Query('hero') hero?: string,
    @Query('lane') lane?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.builds.listPublic({ hero, lane, sort, page, limit }, user);
  }

  // Emblem talents (enabled, with tier) for the build editor.
  @Get('talents')
  talents() {
    return this.builds.talents();
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@CurrentUser() user: any) {
    return this.builds.listMine(user);
  }

  // Published builds of a hero (same filters as the global list).
  @UseGuards(OptionalJwtGuard)
  @Get('hero/:heroId')
  byHero(
    @CurrentUser() user: any,
    @Param('heroId') heroId: string,
    @Query('lane') lane?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.builds.listPublic({ hero: heroId, lane, sort, page, limit }, user);
  }

  @UseGuards(OptionalJwtGuard)
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.findOne(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateCommunityBuildDto) {
    return this.builds.create(user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateCommunityBuildDto) {
    return this.builds.update(id, user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.remove(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/publish')
  publish(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.publish(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/unpublish')
  unpublish(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.unpublish(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id/like')
  like(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.like(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/like')
  unlike(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.unlike(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/report')
  report(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: ReportCommunityBuildDto) {
    return this.builds.report(id, user, dto);
  }
}
