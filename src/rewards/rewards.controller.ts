import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RewardsService } from './rewards.service';
import { FRAMES, TITLES } from './frames.catalog';
import { EquipFrameDto, EquipTitleDto } from './dto/rewards.dto';

@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  /** Public catalogue: frames and titles definitions. */
  @Get('catalog')
  catalog() {
    return {
      frames: FRAMES.map((f) => this.rewards.serializeDef(f)),
      titles: TITLES,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/collection')
  collection(@CurrentUser() user: any) {
    return this.rewards.collection(user.id);
  }

  /** Equips a frame (`frameId` or `frameId:variant`); null = back to the rank frame. */
  @UseGuards(JwtAuthGuard)
  @Post('me/frame')
  equipFrame(@CurrentUser() user: any, @Body() dto: EquipFrameDto) {
    return this.rewards.equipFrame(user.id, dto.frameId ?? null, dto.variant ?? null);
  }

  /** Equips an unlocked level title; null = no title. */
  @UseGuards(JwtAuthGuard)
  @Post('me/title')
  equipTitle(@CurrentUser() user: any, @Body() dto: EquipTitleDto) {
    return this.rewards.equipTitle(user.id, dto.titleId ?? null);
  }
}
