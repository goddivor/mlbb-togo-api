import { Body, Controller, Get, Param, Patch, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { StandingsService } from './standings.service';
import { UpdateStandingsSettingsDto } from './dto/standings-settings.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('standings')
export class StandingsController {
  constructor(private readonly standings: StandingsService) {}

  /** GET /standings?seasonId=<id|slug|current>&type=league|playoff|all */
  @Get()
  getStandings(@Query('seasonId') seasonId?: string, @Query('type') type?: string) {
    return this.standings.getStandings(seasonId, type);
  }

  /** GET /standings/h2h?seasonId&teamA&teamB (teamB optional: every opponent) */
  @Get('h2h')
  getHeadToHead(
    @Query('teamA') teamA: string,
    @Query('seasonId') seasonId?: string,
    @Query('teamB') teamB?: string,
    @Query('type') type?: string,
  ) {
    return this.standings.getHeadToHead(seasonId, teamA, teamB, type);
  }

  /** GET /standings/export.pdf?seasonId&type&lang=fr|en */
  @Get('export.pdf')
  async exportPdf(
    @Res() res: Response,
    @Query('seasonId') seasonId?: string,
    @Query('type') type?: string,
    @Query('lang') lang?: string,
  ) {
    const { buffer, filename } = await this.standings.exportPdf(seasonId, type, lang);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  }

  /** Per-season standings settings (public read). */
  @Get('settings/:seasonId')
  getSettings(@Param('seasonId') seasonId: string) {
    return this.standings.getSettings(seasonId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('settings/:seasonId')
  updateSettings(@Param('seasonId') seasonId: string, @Body() dto: UpdateStandingsSettingsDto) {
    return this.standings.updateSettings(seasonId, dto);
  }
}
