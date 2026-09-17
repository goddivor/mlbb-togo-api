import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotificationsQueryDto } from './dto/notifications-query.dto';

// Notifications are strictly personal: every route below reads the owner from
// the JWT (never from the request) so one account can neither read nor mutate
// another account's mailbox.
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly community: CommunityService) {}

  @Get()
  list(@CurrentUser() user: any, @Query() query: NotificationsQueryDto) {
    return this.community.listNotifications(user.id, query);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: any) {
    return this.community.unreadCount(user.id);
  }

  @Patch('read-all')
  readAll(@CurrentUser() user: any, @Query() query: NotificationsQueryDto) {
    return this.community.markAllRead(user.id, query.type);
  }

  @Patch(':id/read')
  read(@CurrentUser() user: any, @Param('id') id: string) {
    return this.community.markRead(user.id, id);
  }
}
