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
import { EsportService } from './esport.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('esport')
export class EsportController {
  constructor(private readonly esport: EsportService) {}

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
  getTeam(@Param('id') id: string) {
    return this.esport.getTeam(id);
  }

  @Get('teams/:id/matches')
  getTeamMatches(@Param('id') id: string) {
    return this.esport.getTeamMatches(id);
  }

  // ----- Join requests -----

  @UseGuards(JwtAuthGuard)
  @Get('join-requests/mine')
  myJoinRequests(@CurrentUser() user: any) {
    return this.esport.myJoinRequests(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('teams/:id/join')
  requestJoin(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.esport.requestJoin(user.id, id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('teams/:id/join-requests')
  listJoinRequests(@Param('id') id: string, @CurrentUser() user: any) {
    return this.esport.listJoinRequests(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('join-requests/:id')
  decideJoinRequest(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.esport.decideJoinRequest(id, user, body);
  }

  @Get('sponsors')
  getSponsors() {
    return this.esport.getSponsors();
  }

  @Get('mtl')
  getMtl() {
    return this.esport.getMtl();
  }

  @Get('seasons')
  getSeasons() {
    return this.esport.listSeasons();
  }

  @Get('seasons/:id')
  getSeason(@Param('id') id: string) {
    return this.esport.getSeason(id);
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

  // ----- Admin: organisation -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id')
  updateOrg(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateOrg(id, body);
  }

  // ----- Admin: équipes -----

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

  // ----- Admin: membres -----

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
  createSeason(@Body() body: any) {
    return this.esport.createSeason(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('seasons/:id')
  updateSeason(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateSeason(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('seasons/:id')
  deleteSeason(@Param('id') id: string) {
    return this.esport.deleteSeason(id);
  }

  // ----- Matches (admin, ou capitaine pour amical/entraînement) -----

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

  @UseGuards(JwtAuthGuard)
  @Delete('matches/:id')
  deleteMatch(@Param('id') id: string, @CurrentUser() user: any) {
    return this.esport.deleteMatch(id, user);
  }
}
