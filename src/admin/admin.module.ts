import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { LeagueService } from './league.service';
import { EsportModule } from '../esport/esport.module';
import { StandingsModule } from '../standings/standings.module';
import { AwardsModule } from '../awards/awards.module';
import { LeagueStatsModule } from '../league-stats/league-stats.module';
import { GamificationModule } from '../gamification/gamification.module';
import { PlayerStatsModule } from '../stats/player-stats.module';
import { PostsModule } from '../posts/posts.module';
import { StreamModule } from '../stream/stream.module';

@Module({
  imports: [
    EsportModule,
    StandingsModule,
    AwardsModule,
    LeagueStatsModule,
    GamificationModule,
    PlayerStatsModule,
    PostsModule,
    StreamModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, LeagueService],
  exports: [AdminService, LeagueService],
})
export class AdminModule {}
