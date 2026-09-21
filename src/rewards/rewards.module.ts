import { Module } from '@nestjs/common';
import { GamificationModule } from '../gamification/gamification.module';
import { RewardsCoreModule } from './rewards-core.module';
import { RewardsAdminService } from './rewards-admin.service';
import { RewardsController } from './rewards.controller';
import { RewardsAdminController } from './rewards-admin.controller';
import { RewardsCronController } from './rewards-cron.controller';

@Module({
  imports: [RewardsCoreModule, GamificationModule],
  controllers: [RewardsController, RewardsAdminController, RewardsCronController],
  providers: [RewardsAdminService],
})
export class RewardsModule {}
