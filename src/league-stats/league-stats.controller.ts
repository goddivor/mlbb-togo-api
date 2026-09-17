import { Controller, Get, Query } from '@nestjs/common';
import { LeagueStatsService } from './league-stats.service';

/**
 * Public league statistics (teams / players / meta / records) computed from
 * the completed esport matches and their per-player stats.
 * `seasonId` accepts a season id, `current` or `all` (default).
 */
@Controller('league-stats')
export class LeagueStatsController {
  constructor(private readonly stats: LeagueStatsService) {}

  @Get('teams')
  teams(@Query('seasonId') seasonId?: string) {
    return this.stats.teams(seasonId);
  }

  @Get('players')
  players(
    @Query('seasonId') seasonId?: string,
    @Query('role') role?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
  ) {
    return this.stats.players({ seasonId, role, sort, limit });
  }

  @Get('meta')
  meta(
    @Query('seasonId') seasonId?: string,
    @Query('minGames') minGames?: string,
    @Query('limit') limit?: string,
  ) {
    return this.stats.meta({ seasonId, minGames, limit });
  }

  @Get('records')
  records(@Query('seasonId') seasonId?: string, @Query('period') period?: string) {
    return this.stats.records({ seasonId, period });
  }
}
