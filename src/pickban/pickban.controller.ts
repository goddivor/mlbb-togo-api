import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PickBanService } from './pickban.service';
import { CreatePickBanDraftDto } from './dto/create-pick-ban-draft.dto';
import { UpdatePickBanStepDto } from './dto/update-pick-ban-step.dto';
import { SuggestPickBanDto, SuggestPickBanResponseDto } from './dto/suggest-pick-ban.dto';

@Controller('pickban')
export class PickBanController {
  constructor(private service: PickBanService) {}

  /* ---------- Public endpoints ---------- */

  /**
   * GET /pickban/share/:code
   * Get a draft by share code (public read).
   */
  @Get('share/:code')
  async getByShareCode(@Param('code') code: string) {
    return this.service.getByShareCode(code);
  }

  /**
   * POST /pickban/suggest
   * Get hero suggestions for the next draft action (public).
   */
  @Post('suggest')
  async suggestNext(
    @Body() dto: SuggestPickBanDto,
  ): Promise<SuggestPickBanResponseDto> {
    return this.service.suggestNext(dto);
  }

  /* ---------- Authenticated endpoints ---------- */

  /**
   * POST /pickban
   * Create a new draft.
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Request() req, @Body() dto: CreatePickBanDraftDto) {
    return this.service.create(req.user.id, dto);
  }

  /**
   * GET /pickban/:id
   * Get a draft by ID (owner can read/write, others can read).
   */
  @Get(':id')
  async getById(@Param('id') id: string, @Request() req) {
    return this.service.getById(id, req.user?.id);
  }

  /**
   * GET /pickban
   * List all drafts owned by the current user.
   */
  @UseGuards(JwtAuthGuard)
  @Get()
  async listMine(@Request() req) {
    return this.service.listMine(req.user.id);
  }

  /**
   * PATCH /pickban/:id/step
   * Update the draft with the next pick/ban action.
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/step')
  async updateStep(
    @Param('id') id: string,
    @Body() dto: UpdatePickBanStepDto,
    @Request() req,
  ) {
    return this.service.updateStep(id, req.user.id, dto);
  }

  /**
   * PATCH /pickban/:id/reset
   * Reset the draft to the initial state.
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/reset')
  async reset(@Param('id') id: string, @Request() req) {
    return this.service.reset(id, req.user.id);
  }

  /**
   * DELETE /pickban/:id
   * Delete a draft (owner only).
   */
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteDraft(@Param('id') id: string, @Request() req) {
    return this.service.deleteDraft(id, req.user.id);
  }
}
