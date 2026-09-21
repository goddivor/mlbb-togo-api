import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { ItemsService } from './items.service';
import { CreateItemDto, UpdateItemDto } from './dto/item.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';

@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Get()
  async findAll() {
    return this.itemsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.itemsService.findOne(id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Post()
  async create(@Body() data: CreateItemDto) {
    return this.itemsService.create(data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() data: UpdateItemDto) {
    return this.itemsService.update(id, data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.itemsService.delete(id);
  }
}
