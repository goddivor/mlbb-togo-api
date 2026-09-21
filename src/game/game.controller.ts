import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { GameService } from './game.service';
import { OptionalJwtGuard } from './optional-jwt.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

const int = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

/** Public read API of the cached game account data (never exposes the Moonton token). */
@UseGuards(OptionalJwtGuard)
@Controller('users/:id/game')
export class GameController {
  constructor(private readonly game: GameService) {}

  @Get()
  summary(@Param('id') id: string, @CurrentUser() viewer: any) {
    return this.game.getSummary(id, viewer);
  }

  @Get('matches')
  matches(
    @Param('id') id: string,
    @CurrentUser() viewer: any,
    @Query('season') season?: string,
    @Query('hero') hero?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.game.listMatches(id, viewer, {
      season: int(season),
      hero: int(hero),
      page: int(page),
      limit: int(limit),
    });
  }

  @Get('matches/:bid')
  match(@Param('id') id: string, @Param('bid') bid: string, @CurrentUser() viewer: any) {
    return this.game.getMatch(id, bid, viewer);
  }
}
