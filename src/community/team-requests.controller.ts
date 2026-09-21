import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('team-requests')
export class TeamRequestsController {
  constructor(private readonly community: CommunityService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: any, @Body() body: any) {
    return this.community.createTeamRequest(user.id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@CurrentUser() user: any) {
    return this.community.myTeamRequests(user.id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.requests')
  @Get()
  list(@Query('status') status?: string) {
    return this.community.listTeamRequests(status);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.requests')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.community.getTeamRequest(id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.requests')
  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() body: any) {
    return this.community.setTeamRequestStatus(id, body.status);
  }
}
