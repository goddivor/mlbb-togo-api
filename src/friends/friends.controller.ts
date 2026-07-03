import { Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get()
  list(@CurrentUser() user: any) {
    return this.friends.listFriends(user.id);
  }

  @Get('requests')
  requests(@CurrentUser() user: any) {
    return this.friends.listRequests(user.id);
  }

  @Get('status/:userId')
  status(@CurrentUser() user: any, @Param('userId') userId: string) {
    return this.friends.statusWith(user.id, userId);
  }

  @Post(':userId/accept')
  accept(@CurrentUser() user: any, @Param('userId') userId: string) {
    return this.friends.accept(user.id, userId);
  }

  @Post(':userId')
  request(@CurrentUser() user: any, @Param('userId') userId: string) {
    return this.friends.sendRequest(user.id, userId);
  }

  @Delete(':userId')
  remove(@CurrentUser() user: any, @Param('userId') userId: string) {
    return this.friends.remove(user.id, userId);
  }
}
