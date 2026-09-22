import { Module } from '@nestjs/common';
import { CommunityBuildsController } from './community-builds.controller';
import { CommunityBuildsModerationController } from './community-builds-moderation.controller';
import { CommunityBuildsService } from './community-builds.service';
import { CommunityBuildsEvents } from './community-builds.events';

/**
 * Player-made hero builds (#129). Exports CommunityBuildsEvents so another
 * module (XP, achievements) can subscribe to published / liked events.
 */
@Module({
  controllers: [CommunityBuildsModerationController, CommunityBuildsController],
  providers: [CommunityBuildsService, CommunityBuildsEvents],
  exports: [CommunityBuildsService, CommunityBuildsEvents],
})
export class CommunityBuildsModule {}
