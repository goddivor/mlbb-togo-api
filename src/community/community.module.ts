import { Module } from '@nestjs/common';
import { CommunityService } from './community.service';
import { NotificationsController } from './notifications.controller';
import { TeamRequestsController } from './team-requests.controller';
import { MessagesController } from './messages.controller';

@Module({
  controllers: [
    NotificationsController,
    TeamRequestsController,
    MessagesController,
  ],
  providers: [CommunityService],
  exports: [CommunityService],
})
export class CommunityModule {}
