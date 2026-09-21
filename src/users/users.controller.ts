import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { PlayerStatsService } from '../stats/player-stats.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly playerStats: PlayerStatsService,
  ) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get('leaderboard')
  leaderboard(@Query() query: LeaderboardQueryDto) {
    return this.usersService.leaderboard(query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get('admin')
  adminList() {
    return this.usersService.adminList();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findPublic(id);
  }

  // Public: aggregated esport stats (win rate, KDA, heroes, badges...).
  @Get(':id/stats')
  stats(@Param('id') id: string) {
    return this.playerStats.getUserStats(id);
  }

  // Public: paginated esport match history.
  @Get(':id/matches')
  matches(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.playerStats.getUserMatches(id, Number(page) || 1, Number(limit) || 10);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    // Only the account owner (or staff) may edit a profile.
    if (user.id !== id && user.roleUser !== 'admin' && user.roleUser !== 'moderator') {
      throw new ForbiddenException('Modification non autorisée.');
    }
    return this.usersService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me')
  deleteSelf(@CurrentUser() user: any) {
    return this.usersService.deleteSelf(user.id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch(':id/ban')
  ban(@Param('id') id: string, @Body('isBanned') isBanned: boolean) {
    return this.usersService.setBan(id, isBanned);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/role')
  setRole(@Param('id') id: string, @Body('roleUser') roleUser: string) {
    return this.usersService.setRole(id, roleUser);
  }
}
