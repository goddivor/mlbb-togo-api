import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CommunityBuildsService } from './community-builds.service';
import { HideCommunityBuildDto } from './dto/community-build.dto';

/** Moderation of the community builds (`builds.moderate`); every action is logged. */
@Controller('moderation/community-builds')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('builds.moderate')
export class CommunityBuildsModerationController {
  constructor(private readonly builds: CommunityBuildsService) {}

  // filter = reported (default, open reports) | hidden | all (published + hidden).
  @Get()
  list(
    @CurrentUser() user: any,
    @Query('filter') filter?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.builds.moderationList({ filter, page, limit }, user);
  }

  @Post(':id/hide')
  hide(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: HideCommunityBuildDto) {
    return this.builds.hide(id, user, dto);
  }

  @Post(':id/unhide')
  unhide(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.unhide(id, user);
  }

  @Post(':id/dismiss-reports')
  dismiss(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.dismissReports(id, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.builds.moderatorDelete(id, user);
  }
}
