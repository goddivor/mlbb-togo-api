import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PushService } from './push.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('public-key')
  publicKey() {
    return { key: this.push.getPublicKey() };
  }

  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  subscribe(@CurrentUser() user: any, @Body() sub: any) {
    return this.push.subscribe(user.id, sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('unsubscribe')
  unsubscribe(@Body('endpoint') endpoint: string) {
    return this.push.unsubscribe(endpoint);
  }
}
