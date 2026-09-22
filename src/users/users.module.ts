import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PlayerStatsModule } from '../stats/player-stats.module';
import { GamificationModule } from '../gamification/gamification.module';

@Module({
  imports: [PlayerStatsModule, GamificationModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
