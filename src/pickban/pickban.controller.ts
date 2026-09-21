import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PickBanService } from './pickban.service';
import {
  CreatePickBanDraftDto,
  SuggestPickBanDto,
  SuggestPickBanResponseDto,
  UpdatePickBanStepDto,
} from './dto/pickban.dto';

// Pick & ban draft simulator (hero drafting). Distinct from `/draft`, which is
// the community tournament draft (random team composition).
@Controller('pickban')
export class PickBanController {
  constructor(private readonly service: PickBanService) {}

  /* ---------- Public ---------- */

  // Hero catalogue with lanes/thumbs/rates for the draft board.
  @Get('heroes')
  listHeroes() {
    return this.service.listHeroes();
  }

  // Read-only access to a shared draft.
  @Get('share/:code')
  getByShareCode(@Param('code') code: string) {
    return this.service.getByShareCode(code);
  }

  // Ranked suggestions for the next action of the given board state.
  @Post('suggest')
  suggest(@Body() dto: SuggestPickBanDto): Promise<SuggestPickBanResponseDto> {
    return this.service.suggestNext(dto);
  }

  /* ---------- Owner (JWT) ---------- */

  @UseGuards(JwtAuthGuard)
  @Get()
  listMine(@Request() req: any) {
    return this.service.listMine(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Request() req: any, @Body() dto: CreatePickBanDraftDto) {
    return this.service.create(req.user.id, dto);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/step')
  updateStep(@Param('id') id: string, @Request() req: any, @Body() dto: UpdatePickBanStepDto) {
    return this.service.updateStep(id, req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/undo')
  undo(@Param('id') id: string, @Request() req: any) {
    return this.service.undo(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/reset')
  reset(@Param('id') id: string, @Request() req: any) {
    return this.service.reset(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.service.deleteDraft(id, req.user.id);
  }
}
