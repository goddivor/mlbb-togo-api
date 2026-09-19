import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TeamsModule } from './teams/teams.module';
import { PostsModule } from './posts/posts.module';
import { TournamentsModule } from './tournaments/tournaments.module';
import { EventsModule } from './events/events.module';
import { MatchesModule } from './matches/matches.module';
import { HeroesModule } from './heroes/heroes.module';
import { AdminModule } from './admin/admin.module';
import { MlbbModule } from './mlbb/mlbb.module';
import { EsportModule } from './esport/esport.module';
import { ContactModule } from './contact/contact.module';
import { CommunityModule } from './community/community.module';
import { FriendsModule } from './friends/friends.module';
import { RecruitmentModule } from './recruitment/recruitment.module';
import { LanesModule } from './lanes/lanes.module';
import { ItemsModule } from './items/items.module';
import { EmblemsModule } from './emblems/emblems.module';
import { BattleSpellsModule } from './battle-spells/battle-spells.module';
import { BuildsModule } from './builds/builds.module';
import { GqlModule } from './graphql/gql.module';
import { PushModule } from './push/push.module';
import { StreamModule } from './stream/stream.module';
import { DraftModule } from './draft/draft.module';
import { SearchModule } from './search/search.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GamificationModule } from './gamification/gamification.module';
import { PickBanModule } from './pickban/pickban.module';
import { AiModule } from './ai/ai.module';
import { LeagueStatsModule } from './league-stats/league-stats.module';
import { StandingsModule } from './standings/standings.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    TeamsModule,
    PostsModule,
    TournamentsModule,
    EventsModule,
    MatchesModule,
    HeroesModule,
    AdminModule,
    MlbbModule,
    EsportModule,
    ContactModule,
    CommunityModule,
    FriendsModule,
    RecruitmentModule,
    LanesModule,
    ItemsModule,
    EmblemsModule,
    BattleSpellsModule,
    BuildsModule,
    GqlModule,
    PushModule,
    StreamModule,
    DraftModule,
    SearchModule,
    DashboardModule,
    GamificationModule,
    PickBanModule,
    AiModule,
    LeagueStatsModule,
    StandingsModule,
  ],
})
export class AppModule {}
