import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CommunityService } from './community.service';
import { ChatGateway } from './chat.gateway';
import { NotificationsController } from './notifications.controller';
import { TeamRequestsController } from './team-requests.controller';
import { MessagesController } from './messages.controller';
import { JWT_SECRET } from '../auth/jwt.strategy';

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET })],
  controllers: [
    NotificationsController,
    TeamRequestsController,
    MessagesController,
  ],
  providers: [CommunityService, ChatGateway],
  exports: [CommunityService],
})
export class CommunityModule {}
