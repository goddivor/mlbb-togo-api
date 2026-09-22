import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { GamificationService } from './gamification.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('gamification')
export class GamificationController {
  constructor(private readonly gamification: GamificationService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: any) {
    // Opening the progression page counts as the visit of the day.
    await this.gamification.trackDailyLogin(user.id);
    return this.gamification.getMe(user.id);
  }

  /**
   * "Watching the live" ping from the Stream page (spectator achievement):
   * counted at most once per user and per day, only while a live is on.
   */
  @Post('me/spectator')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  spectator(@CurrentUser() user: any) {
    return this.gamification.trackSpectator(user.id);
  }

  @Get('leaderboard')
  leaderboard(@Query('limit') limit?: string) {
    return this.gamification.leaderboard(limit ? Number(limit) : undefined);
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.gamification.getPublic(id);
  }
}
