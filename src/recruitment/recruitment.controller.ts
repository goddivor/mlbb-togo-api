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

@Controller('recruitment')
export class RecruitmentController {
  constructor(private readonly recruitment: RecruitmentService) {}

  @Get()
  listOpen(@Query('role') role?: string) {
    return this.recruitment.listOpen(role);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@CurrentUser() user: any) {
    return this.recruitment.myApplications(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('team/:teamId')
  byTeam(@Param('teamId') teamId: string, @CurrentUser() user: any) {
    return this.recruitment.listByTeam(teamId, user);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: any, @Body() body: any) {
    return this.recruitment.create(user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('applications/:appId')
  decide(@Param('appId') appId: string, @CurrentUser() user: any, @Body() body: any) {
    return this.recruitment.decideApplication(appId, user, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/apply')
  apply(@Param('id') id: string, @CurrentUser() user: any, @Body() body: any) {
    return this.recruitment.apply(user, id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/applications')
  applications(@Param('id') id: string, @CurrentUser() user: any) {
    return this.recruitment.listApplications(id, user);
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
