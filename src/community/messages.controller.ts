import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CommunityService } from './community.service';
import { RoomsService } from './rooms.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('messages')
export class MessagesController {
  constructor(
    private readonly community: CommunityService,
    private readonly rooms: RoomsService,
  ) {}

  // ----- Unread badges (direct + rooms) -----

  @UseGuards(JwtAuthGuard)
  @Get('unread')
  unread(@CurrentUser() user: any) {
    return this.rooms.unreadSummary(user.id);
  }

  // ----- Group rooms (team / tournament / draft team) -----

  @UseGuards(JwtAuthGuard)
  @Get('rooms')
  listRooms(@CurrentUser() user: any) {
    return this.rooms.listRooms(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('rooms/:kind/:scopeId')
  getRoom(
    @CurrentUser() user: any,
    @Param('kind') kind: string,
    @Param('scopeId') scopeId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rooms.getRoom(user.id, kind, scopeId, { before, limit });
  }

  @UseGuards(JwtAuthGuard)
  @Post('rooms/:kind/:scopeId')
  postRoomMessage(
    @CurrentUser() user: any,
    @Param('kind') kind: string,
    @Param('scopeId') scopeId: string,
    @Body() body: any,
  ) {
    return this.rooms.postMessage(user.id, kind, scopeId, body?.body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('rooms/:kind/:scopeId/read')
  markRoomRead(
    @CurrentUser() user: any,
    @Param('kind') kind: string,
    @Param('scopeId') scopeId: string,
  ) {
    return this.rooms.markRead(user.id, kind, scopeId);
  }

  // ----- Direct (1-1) threads -----

  @UseGuards(JwtAuthGuard)
  @Post('threads')
  startThread(@CurrentUser() user: any, @Body() body: any) {
    return this.community.startThread(user.id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('threads')
  listThreads(@CurrentUser() user: any) {
    return this.community.listThreads(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('threads/:id')
  getThread(@CurrentUser() user: any, @Param('id') id: string) {
    return this.community.getThread(user.id, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('threads/:id')
  reply(@CurrentUser() user: any, @Param('id') id: string, @Body() body: any) {
    return this.community.reply(user.id, id, body.body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('threads/:id/read')
  markRead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.community.markThreadRead(user.id, id);
  }
}
