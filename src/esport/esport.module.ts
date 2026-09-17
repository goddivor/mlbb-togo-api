import { Module } from '@nestjs/common';
import { EsportController } from './esport.controller';
import { EsportService } from './esport.service';
import { PlayerStatsModule } from '../stats/player-stats.module';
import { GamificationModule } from '../gamification/gamification.module';
import { EsportStatsService } from './esport-stats.service';
import { EsportStaffService } from './esport-staff.service';

@Module({
  imports: [PlayerStatsModule, GamificationModule],
  controllers: [EsportController],
  providers: [EsportService, EsportStatsService, EsportStaffService],
  exports: [EsportService, EsportStatsService, EsportStaffService],
})
export class EsportModule {}
