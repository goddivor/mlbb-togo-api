import { Module } from '@nestjs/common';
import { EsportModule } from '../esport/esport.module';
import { LeagueStatsController } from './league-stats.controller';
import { LeagueStatsService } from './league-stats.service';

@Module({
  imports: [EsportModule],
  controllers: [LeagueStatsController],
  providers: [LeagueStatsService],
  exports: [LeagueStatsService],
})
export class LeagueStatsModule {}
