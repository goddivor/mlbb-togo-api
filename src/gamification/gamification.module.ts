import { Module } from '@nestjs/common';
import { GamificationService } from './gamification.service';
import { GamificationController } from './gamification.controller';
import { RewardEventsService } from './reward-events.service';
import { SeasonRewardsService } from './season-rewards.service';
import { CommunityModule } from '../community/community.module';
import { RewardsCoreModule } from '../rewards/rewards-core.module';
import { StreamModule } from '../stream/stream.module';

@Module({
  imports: [CommunityModule, RewardsCoreModule, StreamModule],
  controllers: [GamificationController],
  providers: [GamificationService, RewardEventsService, SeasonRewardsService],
  exports: [GamificationService, RewardEventsService, SeasonRewardsService],
})
export class GamificationModule {}
