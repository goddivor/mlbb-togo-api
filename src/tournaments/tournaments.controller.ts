import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TournamentsService } from './tournaments.service';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { UpdateTournamentDto } from './dto/update-tournament.dto';
import {
  GenerateBracketDto,
  MatchResultDto,
  MatchStatusDto,
  ScheduleMatchDto,
  SetMvpDto,
} from './dto/bracket.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournamentsService: TournamentsService) {}

  @Get()
  findAll() {
    return this.tournamentsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tournamentsService.findOne(id);
  }

  /** Public detail view: participants, bracket, results, MVP, schedule, live match. */
  @Get(':id/details')
  details(@Param('id') id: string) {
    return this.tournamentsService.getDetails(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post()
  create(@Body() dto: CreateTournamentDto) {
    return this.tournamentsService.create(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTournamentDto) {
    return this.tournamentsService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tournamentsService.remove(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/register')
  register(@Param('id') id: string, @Body('teamId') teamId: string) {
    return this.tournamentsService.register(id, teamId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/register/:teamId')
  unregister(@Param('id') id: string, @Param('teamId') teamId: string) {
    return this.tournamentsService.unregister(id, teamId);
  }

  // ----- Admin: bracket management -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post(':id/bracket/generate')
  generateBracket(@Param('id') id: string, @Body() dto: GenerateBracketDto) {
    return this.tournamentsService.generateBracket(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete(':id/bracket')
  resetBracket(@Param('id') id: string) {
    return this.tournamentsService.resetBracket(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/matches/:matchId/result')
  setMatchResult(
    @Param('id') id: string,
    @Param('matchId') matchId: string,
    @Body() dto: MatchResultDto,
  ) {
    return this.tournamentsService.setMatchResult(id, matchId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/matches/:matchId/schedule')
  scheduleMatch(
    @Param('id') id: string,
    @Param('matchId') matchId: string,
    @Body() dto: ScheduleMatchDto,
  ) {
    return this.tournamentsService.scheduleMatch(id, matchId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/matches/:matchId/status')
  setMatchStatus(
    @Param('id') id: string,
    @Param('matchId') matchId: string,
    @Body() dto: MatchStatusDto,
  ) {
    return this.tournamentsService.setMatchStatus(id, matchId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/mvp')
  setMvp(@Param('id') id: string, @Body() dto: SetMvpDto) {
    return this.tournamentsService.setMvp(id, dto);
  }
}
