import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { BattleSpellsService } from './battle-spells.service';
import { CreateBattleSpellDto, UpdateBattleSpellDto } from './dto/battle-spell.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';

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

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Post()
  async create(@Body() data: CreateBattleSpellDto) {
    return this.battleSpellsService.create(data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() data: UpdateBattleSpellDto) {
    return this.battleSpellsService.update(id, data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.battleSpellsService.delete(id);
  }
}
