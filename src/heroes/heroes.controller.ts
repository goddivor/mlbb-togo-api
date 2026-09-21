import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { HeroesService } from './heroes.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { HeroMetaService } from '../mlbb/hero-meta.service';
import { orUnavailable } from '../mlbb/gms-http.util';

@Controller('heroes')
export class HeroesController {
  constructor(
    private readonly heroesService: HeroesService,
    private readonly heroMeta: HeroMetaService,
  ) {}

  @Get()
  findAll(@Query('role') role?: string) {
    return this.heroesService.findAll(role);
  }

  // Refreshes the heroes cache from the Moonton API (admin only).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Post('refresh')
  refresh() {
    return this.heroesService.refreshFromMlbb();
  }

  // ----- Live Moonton meta (cached, see HeroMetaService) -----
  // `heroId` below is the numeric Moonton hero id. Rates are percentages.

  // Win/pick/ban ranking. rank: all|epic|legend|mythic|honor|glory,
  // days: 1|3|7|15|30, role/lane filters, sort: winRate|pickRate|banRate.
  @Get('meta/ranking')
  ranking(
    @Query('rank') rank?: string,
    @Query('days') days?: string,
    @Query('role') role?: string,
    @Query('lane') lane?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(this.heroMeta.getRanking({ rank, days, role, lane, sort, order, lang }));
  }

  // Overview: rates, top counters/synergies, skill combos.
  @Get(':heroId/meta')
  meta(@Param('heroId', ParseIntPipe) heroId: number, @Query('lang') lang?: string) {
    return this.heroMeta.getHeroMeta(heroId, lang || 'en');
  }

  @Get(':heroId/meta/stats')
  metaStats(
    @Param('heroId', ParseIntPipe) heroId: number,
    @Query('rank') rank?: string,
    @Query('days') days?: string,
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(this.heroMeta.getHeroStats(heroId, { rank, days, lang }));
  }

  // days: 7|15|30
  @Get(':heroId/meta/trends')
  metaTrends(
    @Param('heroId', ParseIntPipe) heroId: number,
    @Query('rank') rank?: string,
    @Query('days') days?: string,
  ) {
    return orUnavailable(this.heroMeta.getTrends(heroId, { rank, days }));
  }

  // Win rate by game length; lane defaults to the hero's main lane.
  @Get(':heroId/meta/timeline')
  metaTimeline(
    @Param('heroId', ParseIntPipe) heroId: number,
    @Query('rank') rank?: string,
    @Query('lane') lane?: string,
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(this.heroMeta.getTimeline(heroId, { rank, lane, lang }));
  }

  // Top 5 counters for a window (strong = heroes this hero beats).
  @Get(':heroId/meta/counters')
  metaCounters(
    @Param('heroId', ParseIntPipe) heroId: number,
    @Query('rank') rank?: string,
    @Query('days') days?: string,
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(this.heroMeta.getCounters(heroId, { rank, days, lang }));
  }

  // Top 5 teammates for a window.
  @Get(':heroId/meta/compatibility')
  metaCompatibility(
    @Param('heroId', ParseIntPipe) heroId: number,
    @Query('rank') rank?: string,
    @Query('days') days?: string,
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(this.heroMeta.getCompatibility(heroId, { rank, days, lang }));
  }

  // Full matrix: every enemy and every teammate (Academy).
  @Get(':heroId/meta/matchups')
  metaMatchups(
    @Param('heroId', ParseIntPipe) heroId: number,
    @Query('rank') rank?: string,
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(this.heroMeta.getMatchups(heroId, { rank, lang }));
  }

  // Academy recommended builds with their win/pick rates.
  @Get(':heroId/meta/builds')
  metaBuilds(
    @Param('heroId', ParseIntPipe) heroId: number,
    @Query('rank') rank?: string,
    @Query('lane') lane?: string,
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(this.heroMeta.getBuilds(heroId, { rank, lane, lang }));
  }

  @Get(':heroId/meta/combos')
  metaCombos(@Param('heroId', ParseIntPipe) heroId: number, @Query('lang') lang?: string) {
    return orUnavailable(this.heroMeta.getCombos(heroId, lang || 'en'));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.heroesService.findOne(id);
  }
}
