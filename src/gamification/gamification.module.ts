import { Module } from '@nestjs/common';
import { GamificationService } from './gamification.service';
import { GamificationController } from './gamification.controller';
import { CommunityModule } from '../community/community.module';
import { RewardsCoreModule } from '../rewards/rewards-core.module';

@Module({
  imports: [CommunityModule, RewardsCoreModule],
  controllers: [GamificationController],
  providers: [GamificationService],
  exports: [GamificationService],
})
export class GamificationModule {}
