import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { BuildsService } from './builds.service';
import { CreateBuildDto, UpdateBuildDto } from './dto/build.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';

@Controller('heroes/:heroId/builds')
export class BuildsController {
  constructor(private readonly buildsService: BuildsService) {}

  @Get()
  async findByHero(@Param('heroId') heroId: string) {
    return this.buildsService.findByHero(heroId);
  }

  @Get(':buildId')
  async findOne(@Param('buildId') buildId: string) {
    return this.buildsService.findOne(buildId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Post()
  async create(@Param('heroId') heroId: string, @Body() data: CreateBuildDto) {
    return this.buildsService.create(heroId, data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Patch(':buildId')
  async update(@Param('buildId') buildId: string, @Body() data: UpdateBuildDto) {
    return this.buildsService.update(buildId, data);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Delete(':buildId')
  async delete(@Param('buildId') buildId: string) {
    return this.buildsService.delete(buildId);
  }
}
