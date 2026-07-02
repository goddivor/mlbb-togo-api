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
  ],
})
export class AppModule {}
