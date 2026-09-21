import { Module } from '@nestjs/common';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentController } from './recruitment.controller';
import { CommunityModule } from '../community/community.module';
import { GamificationModule } from '../gamification/gamification.module';

@Module({
  imports: [CommunityModule, GamificationModule],
  controllers: [RecruitmentController],
  providers: [RecruitmentService],
})
export class RecruitmentModule {}
