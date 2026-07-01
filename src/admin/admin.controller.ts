import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { CreateLogDto } from './dto/create-log.dto';
import { CreateFormDto } from './dto/create-form.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('logs')
  findAllLogs() {
    return this.adminService.findAllLogs();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Post('logs')
  createLog(@Body() dto: CreateLogDto) {
    return this.adminService.createLog(dto);
  }

  @Get('forms')
  findAllForms() {
    return this.adminService.findAllForms();
  }

  @Get('forms/:id')
  findOneForm(@Param('id') id: string) {
    return this.adminService.findOneForm(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Post('forms')
  createForm(@Body() dto: CreateFormDto) {
    return this.adminService.createForm(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch('forms/:id')
  updateForm(@Param('id') id: string, @Body() dto: Partial<CreateFormDto>) {
    return this.adminService.updateForm(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Delete('forms/:id')
  removeForm(@Param('id') id: string) {
    return this.adminService.removeForm(id);
  }

  @Get('forms/:id/responses')
  findResponses(@Param('id') id: string) {
    return this.adminService.findResponses(id);
  }

  @Post('forms/:id/responses')
  createResponse(
    @Param('id') id: string,
    @Body('data') data: Record<string, any>,
  ) {
    return this.adminService.createResponse(id, data);
  }
}
