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
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get()
  list(@Query('status') status?: string) {
    return this.community.listTeamRequests(status);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.community.getTeamRequest(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() body: any) {
    return this.community.setTeamRequestStatus(id, body.status);
  }
}
