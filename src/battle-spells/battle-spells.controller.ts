import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { BattleSpellsService } from './battle-spells.service';
import { CreateBattleSpellDto, UpdateBattleSpellDto } from './dto/battle-spell.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('battle-spells')
export class BattleSpellsController {
  constructor(private readonly battleSpellsService: BattleSpellsService) {}

  @Get()
  async findAll() {
    return this.battleSpellsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.battleSpellsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Post()
  async create(@Body() data: CreateBattleSpellDto) {
    return this.battleSpellsService.create(data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() data: UpdateBattleSpellDto) {
    return this.battleSpellsService.update(id, data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.battleSpellsService.delete(id);
  }
}
