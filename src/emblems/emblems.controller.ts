import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { EmblemsService } from './emblems.service';
import { CreateEmblemDto, UpdateEmblemDto } from './dto/emblem.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('emblems')
export class EmblemsController {
  constructor(private readonly emblemsService: EmblemsService) {}

  @Get()
  async findAll() {
    return this.emblemsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.emblemsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Post()
  async create(@Body() data: CreateEmblemDto) {
    return this.emblemsService.create(data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() data: UpdateEmblemDto) {
    return this.emblemsService.update(id, data);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.emblemsService.delete(id);
  }
}
