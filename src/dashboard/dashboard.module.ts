import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PlayerStatsModule } from '../stats/player-stats.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PlayerStatsModule, UsersModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
