import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RewardsAdminService } from './rewards-admin.service';
import {
  EndFrameDto,
  GrantFrameDto,
  MvpWeekDto,
  RecalculateDto,
  TournamentResultDto,
  XpCorrectionDto,
} from './dto/rewards.dto';

@Controller('rewards/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('admin.rewards')
export class RewardsAdminController {
  constructor(private readonly admin: RewardsAdminService) {}

  @Get('timeline')
  timeline() {
    return this.admin.timeline();
  }

  @Get('frames')
  frames() {
    return this.admin.frames();
  }

  @Get('temporary')
  temporary() {
    return this.admin.temporary();
  }

  @Get('users/:id/collection')
  userCollection(@Param('id') id: string) {
    return this.admin.userCollection(id);
  }

  @Post('frames/grant')
  grant(@CurrentUser() user: any, @Body() dto: GrantFrameDto) {
    return this.admin.grant(user, dto);
  }

  @Post('frames/end')
  end(@CurrentUser() user: any, @Body() dto: EndFrameDto) {
    return this.admin.end(user, dto);
  }

  @Post('xp-correction')
  correctXp(@CurrentUser() user: any, @Body() dto: XpCorrectionDto) {
    return this.admin.correctXp(user, dto);
  }

  @Get('tournament-results')
  tournamentResults(@Query('tournamentId') tournamentId?: string) {
    return this.admin.tournamentResults(tournamentId || undefined);
  }

  @Post('tournament-results')
  recordTournamentResult(@CurrentUser() user: any, @Body() dto: TournamentResultDto) {
    return this.admin.recordTournamentResult(user, dto);
  }

  @Post('mvp-week')
  setWeeklyMvp(@CurrentUser() user: any, @Body() dto: MvpWeekDto) {
    return this.admin.setWeeklyMvp(user, dto);
  }

  @Post('recalculate')
  recalculate(@CurrentUser() user: any, @Body() dto: RecalculateDto) {
    return this.admin.recalculate(user, dto.userId);
  }
}
