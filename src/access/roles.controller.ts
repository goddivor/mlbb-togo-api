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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ANY_ADMIN } from './permissions';
import { AccessService } from './access.service';
import { CreateRoleDto, RoleMemberDto, UpdateRoleDto } from './dto/role.dto';

@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly access: AccessService) {}

  /** Permission catalogue (grouped, fr/en labels) for the admin UI. */
  @RequirePermissions(ANY_ADMIN)
  @Get('permissions')
  catalogue() {
    return this.access.catalogue();
  }

  @RequirePermissions('admin.roles', 'admin.users')
  @Get()
  list() {
    return this.access.listRoles();
  }

  @RequirePermissions('admin.roles')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.access.getRole(id);
  }

  @RequirePermissions('admin.roles')
  @Post()
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: any) {
    return this.access.createRole(dto, user);
  }

  @RequirePermissions('admin.roles')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentUser() user: any) {
    return this.access.updateRole(id, dto, user);
  }

  @RequirePermissions('admin.roles')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.access.deleteRole(id, user);
  }

  @RequirePermissions('admin.roles')
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: RoleMemberDto, @CurrentUser() user: any) {
    return this.access.addMember(id, dto.userId, user);
  }

  @RequirePermissions('admin.roles')
  @Delete(':id/members/:userId')
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: any,
  ) {
    return this.access.removeMember(id, userId, user);
  }
}
