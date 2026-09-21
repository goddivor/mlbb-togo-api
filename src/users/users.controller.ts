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
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AccessService } from '../access/access.service';
import { hasPermission } from '../access/permissions';
import { SetUserRolesDto } from '../access/dto/role.dto';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly playerStats: PlayerStatsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get('leaderboard')
  leaderboard(@Query() query: LeaderboardQueryDto) {
    return this.usersService.leaderboard(query);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.users', 'admin.roles', 'admin.tournaments')
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
    if (user.id !== id && !hasPermission(user, 'admin.users')) {
      throw new ForbiddenException('Modification non autorisée.');
    }
    return this.usersService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me')
  async deleteSelf(@CurrentUser() user: any) {
    await this.access.assertUserRemovable(user.id);
    return this.usersService.deleteSelf(user.id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('users.delete')
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.access.assertUserRemovable(id);
    return this.usersService.remove(id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.users')
  @Patch(':id/ban')
  ban(@Param('id') id: string, @Body('isBanned') isBanned: boolean) {
    return this.usersService.setBan(id, isBanned);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.roles')
  @Patch(':id/role')
  setRole(
    @Param('id') id: string,
    @Body('roleUser') roleUser: string,
    @CurrentUser() user: any,
  ) {
    // Legacy endpoint: mapped onto the system roles (see AccessService).
    return this.access.setLegacyRole(id, roleUser, user);
  }

  /** Replaces the RBAC roles of a user (safety rules enforced). */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.roles')
  @Patch(':id/roles')
  setRoles(
    @Param('id') id: string,
    @Body() dto: SetUserRolesDto,
    @CurrentUser() user: any,
  ) {
    return this.access.setUserRoles(id, dto.roleIds, user);
  }

  /** Flags a dedicated system account (hidden from player-facing features). */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.users')
  @Patch(':id/system-account')
  setSystemAccount(@Param('id') id: string, @Body('isSystemAccount') value: boolean) {
    return this.usersService.setSystemAccount(id, value === true);
  }
}
