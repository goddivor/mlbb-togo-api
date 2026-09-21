import { Module } from '@nestjs/common';
import { CommunityModule } from '../community/community.module';
import { RewardsService } from './rewards.service';

/**
 * Frames core (grant / expire / equip), without controllers. Imported by the
 * gamification module (level and achievement frames) and by RewardsModule.
 */
@Module({
  imports: [CommunityModule],
  providers: [RewardsService],
  exports: [RewardsService],
})
export class RewardsCoreModule {}
