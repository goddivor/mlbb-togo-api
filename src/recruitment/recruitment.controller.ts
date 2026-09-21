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
import { RecruitmentService } from './recruitment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ListCampaignsQueryDto } from './dto/list-campaigns-query.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { UpdateApplicationStatusDto } from './dto/update-application-status.dto';
import { ApplyRecruitmentDto } from './dto/apply-recruitment.dto';
import {
  APPLICATION_STATUSES,
  APPLICATION_TRANSITIONS,
  RECRUITMENT_AVAILABILITY,
} from './recruitment.constants';

@Controller('recruitment')
export class RecruitmentController {
  constructor(private readonly recruitment: RecruitmentService) {}

  @Get()
  listOpen(@Query() query: ListCampaignsQueryDto) {
    return this.recruitment.listOpen(query);
  }

  /**
   * Vocabulary of the module (availability levels, statuses, transitions) so
   * the client builds its filters and its status buttons from the server's
   * truth instead of hard-coding a second copy of the state machine.
   */
  @Get('meta')
  meta() {
    return {
      availability: RECRUITMENT_AVAILABILITY,
      statuses: APPLICATION_STATUSES,
      transitions: APPLICATION_TRANSITIONS,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@CurrentUser() user: any, @Query() query: ListApplicationsQueryDto) {
    return this.recruitment.myApplications(user.id, query);
  }

  @UseGuards(JwtAuthGuard)
  @Get('team/:teamId')
  byTeam(
    @Param('teamId') teamId: string,
    @CurrentUser() user: any,
    @Query() query: ListApplicationsQueryDto,
  ) {
    return this.recruitment.listByTeam(teamId, user, query);
  }

  @UseGuards(JwtAuthGuard)
  @Get('team/:teamId/applications')
  teamApplications(
    @Param('teamId') teamId: string,
    @CurrentUser() user: any,
    @Query() query: ListApplicationsQueryDto,
  ) {
    return this.recruitment.listTeamApplications(teamId, user, query);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: any, @Body() body: any) {
    return this.recruitment.create(user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('applications/:appId')
  updateApplicationStatus(
    @Param('appId') appId: string,
    @CurrentUser() user: any,
    @Body() body: UpdateApplicationStatusDto,
  ) {
    return this.recruitment.updateApplicationStatus(appId, user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/apply')
  apply(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() body: ApplyRecruitmentDto,
  ) {
    return this.recruitment.apply(user, id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/applications')
  applications(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query() query: ListApplicationsQueryDto,
  ) {
    return this.recruitment.listApplications(id, user, query);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @CurrentUser() user: any, @Body() body: any) {
    return this.recruitment.update(id, user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.recruitment.remove(id, user);
  }
}
