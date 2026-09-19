import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AwardsService } from './awards.service';
import { CreateAwardDto, SetPodiumDto, SuggestAwardsDto, UpdateAwardDto } from './dto/award.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * Season awards (#46), podiums and Hall of Fame (#47).
 * Public reads; admin writes. `:id` accepts a season id or slug.
 */
@Controller('awards')
export class AwardsController {
  constructor(private readonly awards: AwardsService) {}

  // ----- Public -----

  /** Closed seasons with podiums, MVP, awards and sponsors (newest first). */
  @Get('hall-of-fame')
  hallOfFame() {
    return this.awards.hallOfFame();
  }

  /** Awards + regular / playoffs podiums + sponsors of a season. */
  @Get('seasons/:id')
  forSeason(@Param('id') id: string) {
    return this.awards.forSeason(id);
  }

  // ----- Admin -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('seasons/:id/suggest')
  suggest(@Param('id') id: string, @Body() dto: SuggestAwardsDto) {
    return this.awards.suggest(id, dto ?? {});
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Put('seasons/:id/podium')
  setPodium(@Param('id') id: string, @Body() dto: SetPodiumDto) {
    return this.awards.setPodium(id, dto ?? {});
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('seasons/:id')
  create(@Param('id') id: string, @Body() dto: CreateAwardDto) {
    return this.awards.create(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':awardId')
  update(@Param('awardId') awardId: string, @Body() dto: UpdateAwardDto) {
    return this.awards.update(awardId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete(':awardId')
  remove(@Param('awardId') awardId: string) {
    return this.awards.remove(awardId);
  }
}
