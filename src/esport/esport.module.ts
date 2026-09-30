import { Module } from '@nestjs/common';
import { EsportController } from './esport.controller';
import { EsportService } from './esport.service';
import { PlayerStatsModule } from '../stats/player-stats.module';
import { GamificationModule } from '../gamification/gamification.module';
import { EsportStatsService } from './esport-stats.service';
import { EsportStaffService } from './esport-staff.service';
import { EsportSeasonsService } from './esport-seasons.service';
import { CommunityModule } from '../community/community.module';

@Module({
  // CommunityModule: dropping a member must clear the cached room membership
  // at once (no import the other way, so no cycle).
  imports: [PlayerStatsModule, GamificationModule, CommunityModule],
  controllers: [EsportController],
  providers: [EsportService, EsportStatsService, EsportStaffService, EsportSeasonsService],
  exports: [EsportService, EsportStatsService, EsportStaffService, EsportSeasonsService],
})
export class EsportModule {}
