import { Module } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { FriendsController } from './friends.controller';
import { CommunityModule } from '../community/community.module';
import { GamificationModule } from '../gamification/gamification.module';

@Module({
  imports: [CommunityModule, GamificationModule],
  controllers: [FriendsController],
  providers: [FriendsService],
})
export class FriendsModule {}
