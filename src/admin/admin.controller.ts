import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { LeagueService } from './league.service';
import { LeagueAnnounceDto } from './dto/league.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateLogDto } from './dto/create-log.dto';
import { CreateFormDto } from './dto/create-form.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly league: LeagueService,
  ) {}

  // ----- League control room (#56) -----

  /** Aggregated season overview: counts, standings, awards, sponsors, checklist. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get('league/overview')
  leagueOverview(@Query('seasonId') seasonId?: string) {
    return this.league.overview(seasonId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Post('league/announce')
  leagueAnnounce(@Body() dto: LeagueAnnounceDto, @CurrentUser() user: any) {
    return this.league.announce(dto, user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('league/recompute')
  leagueRecompute(@Query('seasonId') seasonId: string | undefined, @CurrentUser() user: any) {
    return this.league.recompute(seasonId, user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get('forms')
  findAllForms() {
    return this.adminService.findAllForms();
  }

  // Public: the form definition is needed to render a fillable form.
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
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
