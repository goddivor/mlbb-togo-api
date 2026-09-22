import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RewardsAdminService } from './rewards-admin.service';
import { RewardEventsService } from '../gamification/reward-events.service';
import {
  EndFrameDto,
  GrantFrameDto,
  MvpWeekDto,
  RecalculateDto,
  RewardEventDto,
  TournamentResultDto,
  XpCorrectionDto,
} from './dto/rewards.dto';

@Controller('rewards/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('admin.rewards')
export class RewardsAdminController {
  constructor(
    private readonly admin: RewardsAdminService,
    private readonly events: RewardEventsService,
  ) {}

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

  /** One user, or every user one page at a time (`cursor` / `nextCursor`). */
  @Post('recalculate')
  recalculate(@CurrentUser() user: any, @Body() dto: RecalculateDto) {
    return this.admin.recalculate(user, { userId: dto.userId, cursor: dto.cursor, limit: dto.limit });
  }

  @Get('achievements')
  achievements() {
    return this.admin.achievements();
  }

  // ----- Reward events (catalogue §6.5) -----

  @Get('events')
  listEvents() {
    return this.events.list();
  }

  @Post('events')
  createEvent(@CurrentUser() user: any, @Body() dto: RewardEventDto) {
    return this.events.create(user, dto as any);
  }

  /** Seeds the default events of the catalogue as drafts (idempotent). */
  @Post('events/defaults')
  seedEvents(@CurrentUser() user: any) {
    return this.events.seedDefaults(user);
  }

  @Patch('events/:id')
  updateEvent(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: RewardEventDto) {
    return this.events.update(user, id, dto as any);
  }

  @Delete('events/:id')
  removeEvent(@CurrentUser() user: any, @Param('id') id: string) {
    return this.events.remove(user, id);
  }

  @Post('events/:id/close')
  closeEvent(@CurrentUser() user: any, @Param('id') id: string) {
    return this.events.close(user, id);
  }

  @Post('events/:id/duplicate')
  duplicateEvent(@CurrentUser() user: any, @Param('id') id: string) {
    return this.events.duplicate(user, id);
  }

  @Get('events/:id/eligible')
  eligible(@Param('id') id: string) {
    return this.events.eligible(id);
  }
}
