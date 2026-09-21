import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { EmblemsService } from './emblems.service';
import { CreateEmblemDto, UpdateEmblemDto } from './dto/emblem.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';

@Controller('emblems')
export class EmblemsController {
  constructor(private readonly emblemsService: EmblemsService) {}

  @Get()
  async findAll() {
    return this.emblemsService.findAll();
  }

  // Admin list: includes disabled entries (with their `enabled` flag).
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Get('all')
  async findAllForAdmin() {
    return this.emblemsService.findAll(true);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.emblemsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Post()
  async create(@Body() data: CreateEmblemDto) {
    return this.emblemsService.create(data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() data: UpdateEmblemDto) {
    return this.emblemsService.update(id, data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.emblemsService.delete(id);
  }
}
