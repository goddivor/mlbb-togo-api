import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('messages')
export class MessagesController {
  constructor(private readonly community: CommunityService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
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
}
