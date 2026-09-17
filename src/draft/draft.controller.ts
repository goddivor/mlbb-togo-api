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
import { DraftService } from './draft.service';
import {
  CreateDraftTournamentDto,
  UpdateDraftTournamentDto,
  RegisterDto,
  SetWinnerDto,
  SecondPhaseDto,
} from './dto/draft.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

const ADMIN = ['admin', 'moderator'];

@Controller('draft')
export class DraftController {
  constructor(private readonly draft: DraftService) {}

  /* ---------------- Admin ---------------- */

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Get('admin')
  adminList() {
    return this.draft.adminList();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin')
  create(@Body() dto: CreateDraftTournamentDto, @CurrentUser() user: any) {
    return this.draft.create(dto, user?.id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Patch('admin/:id')
  update(@Param('id') id: string, @Body() dto: UpdateDraftTournamentDto) {
    return this.draft.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Delete('admin/:id')
  remove(@Param('id') id: string) {
    return this.draft.remove(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin/:id/open')
  open(@Param('id') id: string) {
    return this.draft.openRegistration(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin/:id/close')
  close(@Param('id') id: string) {
    return this.draft.closeRegistration(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Get('admin/:id/registrations')
  registrations(@Param('id') id: string) {
    return this.draft.getRegistrations(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin/:id/draft')
  runDraft(@Param('id') id: string) {
    return this.draft.runDraft(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin/:id/second-phase')
  secondPhase(@Param('id') id: string, @Body() dto: SecondPhaseDto) {
    return this.draft.openSecondPhase(id, dto.closesAt);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin/:id/publish')
  publish(@Param('id') id: string) {
    return this.draft.publish(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin/:id/teams/:teamId/eliminate')
  eliminate(@Param('id') id: string, @Param('teamId') teamId: string) {
    return this.draft.eliminateTeam(id, teamId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN)
  @Post('admin/:id/matches/:matchId/winner')
  setWinner(
    @Param('id') id: string,
    @Param('matchId') matchId: string,
    @Body() dto: SetWinnerDto,
  ) {
    return this.draft.setMatchWinner(id, matchId, dto.winnerTeamId);
  }

  /* ---------------- Player ---------------- */

  @UseGuards(JwtAuthGuard)
  @Get()
  list(@CurrentUser() user: any) {
    return this.draft.listForPlayers(user?.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.draft.getForPlayer(id, user?.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/register')
  register(
    @Param('id') id: string,
    @Body() dto: RegisterDto,
    @CurrentUser() user: any,
  ) {
    return this.draft.register(id, user.id, dto.preferredRole);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/register')
  unregister(@Param('id') id: string, @CurrentUser() user: any) {
    return this.draft.unregister(id, user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/bracket')
  bracket(@Param('id') id: string) {
    return this.draft.getBracket(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/my-team')
  myTeam(@Param('id') id: string, @CurrentUser() user: any) {
    return this.draft.getMyTeam(id, user.id);
  }
}
