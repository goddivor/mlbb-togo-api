import { Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly community: CommunityService) {}

  @Get()
  list(@CurrentUser() user: any) {
    return this.community.listNotifications(user.id);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: any) {
    return this.community.unreadCount(user.id);
  }

  @Patch('read-all')
  readAll(@CurrentUser() user: any) {
    return this.community.markAllRead(user.id);
  }

  @Patch(':id/read')
  read(@CurrentUser() user: any, @Param('id') id: string) {
    return this.community.markRead(user.id, id);
  }
}
