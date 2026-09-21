import { Module } from '@nestjs/common';
import { DraftService } from './draft.service';
import { DraftController } from './draft.controller';
import { CommunityModule } from '../community/community.module';
import { GamificationModule } from '../gamification/gamification.module';

@Module({
  imports: [CommunityModule, GamificationModule],
  controllers: [DraftController],
  providers: [DraftService],
  exports: [DraftService],
})
export class DraftModule {}
