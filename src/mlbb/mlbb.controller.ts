import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { MlbbService } from './mlbb.service';
import { HeroMetaService } from './hero-meta.service';
import { orUnavailable } from './gms-http.util';

@Controller('mlbb')
export class MlbbController {
  constructor(
    private readonly mlbb: MlbbService,
    private readonly heroMeta: HeroMetaService,
  ) {}

  @Get('image')
  async image(
    @Query('url') url: string,
    @Query('w') w: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType } = await this.mlbb.proxyImage(
      url,
      w ? Number(w) : undefined,
    );
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.send(buffer);
  }

  @Get('heroes')
  getHeroes(@Query('limit') limit?: string, @Query('lang') lang?: string) {
    return this.mlbb.getHeroes(limit ? Number(limit) : undefined, lang || 'en');
  }

  @Get('heroes/latest')
  getLatest(@Query('count') count?: string, @Query('lang') lang?: string) {
    return this.mlbb.getLatestHeroes(count ? Number(count) : 6, lang || 'en');
  }

  @Get('heroes/showcase')
  getShowcase(@Query('count') count?: string, @Query('lang') lang?: string) {
    return this.mlbb.getShowcaseHeroes(count ? Number(count) : 6, lang || 'en');
  }

  // Legacy ranking shape (rates as fractions). Prefer GET /heroes/meta/ranking.
  @Get('ranking')
  getRanking(
    @Query('rank') rank?: string,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: 'winRate' | 'pickRate' | 'banRate',
    @Query('order') order?: 'desc' | 'asc',
    @Query('lang') lang?: string,
  ) {
    return orUnavailable(
      this.heroMeta.getHeroRanking({
        rank,
        days: days != null ? Number(days) : undefined,
        limit: limit != null ? Number(limit) : undefined,
        sort,
        order,
        lang: lang || 'en',
      }),
    );
  }

  @Get('heroes/:heroId')
  getHero(@Param('heroId', ParseIntPipe) heroId: number, @Query('lang') lang?: string) {
    return this.mlbb.getHero(heroId, lang || 'en');
  }

  @Get('heroes/:heroId/meta')
  getHeroMeta(@Param('heroId', ParseIntPipe) heroId: number, @Query('lang') lang?: string) {
    return this.heroMeta.getHeroMeta(heroId, lang || 'en');
  }
}
