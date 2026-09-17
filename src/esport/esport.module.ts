import { Module } from '@nestjs/common';
import { EsportController } from './esport.controller';
import { EsportService } from './esport.service';
import { PlayerStatsModule } from '../stats/player-stats.module';

@Module({
  imports: [PlayerStatsModule],
  controllers: [EsportController],
  providers: [EsportService],
  exports: [EsportService],
})
export class EsportModule {}
