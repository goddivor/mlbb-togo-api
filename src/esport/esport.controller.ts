import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EsportService } from './esport.service';
import { EsportStatsService } from './esport-stats.service';
import { EsportStaffService } from './esport-staff.service';
import { EsportSeasonsService } from './esport-seasons.service';
import { CloseSeasonDto, CreateSeasonDto, UpdateSeasonDto } from './dto/season.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('esport')
export class EsportController {
  constructor(
    private readonly esport: EsportService,
    private readonly stats: EsportStatsService,
    private readonly staff: EsportStaffService,
    private readonly seasons: EsportSeasonsService,
  ) {}

  // ----- Public -----

  @Get()
  getOrg() {
    return this.esport.getOrg();
  }

  @Get('teams')
  getTeams(@Query('type') type?: string) {
    return this.esport.getTeams(type);
  }

  @Get('teams/:id')
  async getTeam(@Param('id') id: string) {
    const team = await this.esport.getTeam(id);
    const [staff, honours] = await Promise.all([
      this.staff.listStaff(id),
      this.stats.getHonours(id),
    ]);
    return { ...team, staff, honours };
  }

  // ----- Public: team details (stats / history / schedule / staff) -----

  @Get('teams/:id/stats')
  getTeamStats(@Param('id') id: string) {
    return this.stats.getTeamStats(id);
  }

  @Get('teams/:id/history')
  getTeamHistory(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('seasonId') seasonId?: string,
  ) {
    return this.stats.getTeamHistory(id, Number(page) || 1, Number(limit) || 10, seasonId);
  }

  @Get('teams/:id/schedule')
  getTeamSchedule(@Param('id') id: string) {
    return this.stats.getTeamSchedule(id);
  }

  @Get('teams/:id/honours')
  getTeamHonours(@Param('id') id: string) {
    return this.stats.getHonours(id);
  }

  @Get('teams/:id/staff')
  getTeamStaff(@Param('id') id: string) {
    return this.staff.listStaff(id);
  }

  @Get('teams/:id/matches')
  getTeamMatches(@Param('id') id: string) {
    return this.esport.getTeamMatches(id);
  }

  @Get('sponsors')
  getSponsors() {
    return this.esport.getSponsors();
  }

  @Get('org/figures')
  getFigures() {
    return this.esport.getFigures();
  }

  @Get('mtl')
  getMtl() {
    return this.esport.getMtl();
  }

  // ----- Public: seasons (lifecycle, theme, frozen summary) -----

  @Get('seasons')
  getSeasons(@Query('status') status?: string) {
    return this.seasons.list(status);
  }

  @Get('seasons/current')
  getCurrentSeason() {
    return this.seasons.current();
  }

  @Get('seasons/:id')
  getSeason(@Param('id') id: string) {
    return this.seasons.get(id);
  }

  @Get('matches')
  getMatches(
    @Query('seasonId') seasonId?: string,
    @Query('teamId') teamId?: string,
    @Query('status') status?: string,
  ) {
    return this.esport.listMatches({ seasonId, teamId, status });
  }

  @Get('matches/:id')
  getMatch(@Param('id') id: string) {
    return this.esport.getMatch(id);
  }

  @Get('matches/:id/players')
  getMatchPlayers(@Param('id') id: string) {
    return this.esport.getMatchPlayers(id);
  }

  // ----- Admin: organization -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id')
  updateOrg(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateOrg(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Put('org/figures')
  updateFigures(@Body() body: any) {
    return this.esport.updateFigures(body);
  }

  // ----- Admin: teams -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('teams')
  createTeam(@Body() body: any) {
    return this.esport.createTeam(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('teams/:id')
  updateTeam(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateTeam(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('teams/:id')
  deleteTeam(@Param('id') id: string) {
    return this.esport.deleteTeam(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('teams/:id/transform')
  transformTeam(@Param('id') id: string) {
    return this.esport.transformToEsport(id);
  }

  // ----- Admin: members -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('teams/:id/members')
  addMember(@Param('id') id: string, @Body() body: any) {
    return this.esport.addMember(id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('teams/:id/members/:userId')
  updateMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.esport.updateMember(id, userId, body, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('teams/:id/members/:userId')
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: any,
  ) {
    return this.esport.removeMember(id, userId, user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('teams/:id/captain')
  setCaptain(@Param('id') id: string, @Body() body: any) {
    return this.esport.setCaptain(id, body.userId);
  }

  // ----- Admin: staff & honours -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('teams/:id/staff')
  addStaff(@Param('id') id: string, @Body() body: any) {
    return this.staff.addStaff(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('teams/:id/staff/:staffId')
  updateStaff(
    @Param('id') id: string,
    @Param('staffId') staffId: string,
    @Body() body: any,
  ) {
    return this.staff.updateStaff(id, staffId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('teams/:id/staff/:staffId')
  removeStaff(@Param('id') id: string, @Param('staffId') staffId: string) {
    return this.staff.removeStaff(id, staffId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Put('teams/:id/honours')
  setHonours(@Param('id') id: string, @Body() body: any) {
    return this.staff.setHonours(id, body?.honours ?? body);
  }

  // ----- Admin: sponsors -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('sponsors')
  createSponsor(@Body() body: any) {
    return this.esport.createSponsor(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('sponsors/:id')
  updateSponsor(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateSponsor(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('sponsors/:id')
  deleteSponsor(@Param('id') id: string) {
    return this.esport.deleteSponsor(id);
  }

  // ----- Admin: seasons -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('seasons')
  createSeason(@Body() body: CreateSeasonDto) {
    return this.seasons.create(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('seasons/:id')
  updateSeason(@Param('id') id: string, @Body() body: UpdateSeasonDto) {
    return this.seasons.update(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('seasons/:id')
  deleteSeason(@Param('id') id: string) {
    return this.seasons.remove(id);
  }

  // Lifecycle: upcoming -> active -> playoffs -> closed (-> reopen).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('seasons/:id/activate')
  activateSeason(@Param('id') id: string) {
    return this.seasons.activate(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('seasons/:id/playoffs')
  startSeasonPlayoffs(@Param('id') id: string) {
    return this.seasons.startPlayoffs(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('seasons/:id/summary-preview')
  previewSeasonSummary(@Param('id') id: string) {
    return this.seasons.previewSummary(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('seasons/:id/close')
  closeSeason(@Param('id') id: string, @Body() body: CloseSeasonDto) {
    return this.seasons.close(id, body ?? {});
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('seasons/:id/reopen')
  reopenSeason(@Param('id') id: string) {
    return this.seasons.reopen(id);
  }

  // ----- Matches (admin, or captain for friendly/training) -----

  @UseGuards(JwtAuthGuard)
  @Post('matches')
  createMatch(@Body() body: any, @CurrentUser() user: any) {
    return this.esport.createMatch(body, user?.id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('matches/:id/result')
  setMatchResult(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.esport.setMatchResult(id, body, user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('matches/:id')
  updateMatch(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.esport.updateMatch(id, body, user);
  }

  // Per-player stats of a match: full replace of the roster (admin, or
  // captain for friendly/training).
  @UseGuards(JwtAuthGuard)
  @Put('matches/:id/players')
  setMatchPlayers(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.esport.setMatchPlayers(id, body?.players ?? body, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('matches/:id/players/:userId')
  removeMatchPlayer(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: any,
  ) {
    return this.esport.removeMatchPlayer(id, userId, user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('matches/:id')
  deleteMatch(@Param('id') id: string, @CurrentUser() user: any) {
    return this.esport.deleteMatch(id, user);
  }
}
