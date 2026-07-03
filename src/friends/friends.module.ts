import { Module } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { FriendsController } from './friends.controller';
import { CommunityModule } from '../community/community.module';

@Module({
  imports: [CommunityModule],
  controllers: [FriendsController],
  providers: [FriendsService],
})
export class FriendsModule {}
