import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { StreamService } from './stream.service';
import { YoutubeOAuthService } from './youtube-oauth.service';
import { UpdateStreamConfigDto } from './dto/update-stream-config.dto';
import { SetSeasonVideosDto } from './dto/set-season-videos.dto';
import { StartLiveDto } from './dto/start-live.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

const ADMIN = ['admin', 'moderator'];

@Controller('stream')
export class StreamController {
  constructor(
    private readonly streamService: StreamService,
    private readonly youtube: YoutubeOAuthService,
  ) {}

  /* ---------------- Public ---------------- */

  @Get('config')
  getConfig() {
    return this.streamService.getConfig();
  }

  @Get('live')
  getLive() {
    return this.streamService.getLive();
  }

  @Get('views')
  getViews(@Query('videoIds') videoIds: string) {
    return this.streamService.getViews(videoIds);
  }

  // Public: seasons (created by the admin) that have attached videos.
  @Get('seasons')
  getSeasons() {
    return this.streamService.listPublicSeasons();
  }

  // Admin: videos attached to a given season.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Get('seasons/:seasonId/videos')
  getSeasonVideos(@Param('seasonId') seasonId: string) {
    return this.streamService.getSeasonVideos(seasonId);
  }

  // Admin: replace a season's video selection.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Put('seasons/:seasonId/videos')
  setSeasonVideos(
    @Param('seasonId') seasonId: string,
    @Body() dto: SetSeasonVideosDto,
  ) {
    return this.streamService.setSeasonVideos(seasonId, dto.videos || []);
  }

  // OAuth callback: Google redirects here. Not guarded (no bearer in a browser
  // redirect); we finish the exchange then bounce back to the admin page.
  @Get('youtube/callback')
  async youtubeCallback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const base = process.env.FRONTEND_URL || 'http://localhost:3005';
    if (error || !code) {
      return res.redirect(`${base}/admin/stream?connected=0`);
    }
    try {
      await this.youtube.handleCallback(code);
      return res.redirect(`${base}/admin/stream?connected=1`);
    } catch {
      return res.redirect(`${base}/admin/stream?connected=0`);
    }
  }

  /* ---------------- Admin: config ---------------- */

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Patch('config')
  updateConfig(@Body() dto: UpdateStreamConfigDto) {
    return this.streamService.updateConfig(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('refresh')
  refresh() {
    return this.streamService.refreshChannel();
  }

  /* ---------------- Admin: YouTube connection ---------------- */

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Get('youtube/connect')
  connect() {
    return { url: this.youtube.getAuthUrl() };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Get('youtube/status')
  status() {
    return this.youtube.getStatus();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('youtube/disconnect')
  disconnect() {
    return this.youtube.disconnect();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Get('youtube/videos')
  videos(@Query('pageToken') pageToken?: string) {
    return this.youtube.listVideos(pageToken);
  }

  /* ---------------- Admin: live control ---------------- */

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Get('live/panel')
  livePanel() {
    return this.youtube.getLivePanel();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('live/start')
  startLive(@Body() dto: StartLiveDto) {
    return this.youtube.startLive(dto.title, dto.description, dto.privacy);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('live/stop')
  stopLive() {
    return this.youtube.stopLive();
  }
}
