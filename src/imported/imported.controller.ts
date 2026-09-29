import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ImportedService } from './imported.service';
import { ExpectedEmailDto, MergeImportedDto } from './dto/imported.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Admin area of the profiles created by the legacy import (#154). Every
 * endpoint is behind `admin.imported`: the merge is destructive (it deletes
 * the placeholder account), so it is not folded into `admin.users`, which the
 * moderator role holds.
 */
@Controller('imported')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('admin.imported')
export class ImportedController {
  constructor(private readonly imported: ImportedService) {}

  @Get()
  list() {
    return this.imported.list();
  }

  /** Real accounts this profile may be merged into (empty `q` = suggestions). */
  @Get(':id/candidates')
  candidates(@Param('id') id: string, @Query('q') q?: string, @Query('limit') limit?: string) {
    return this.imported.candidates(id, q ?? '', Number(limit) || 20);
  }

  /** What the merge would move, drop and refuse. Read-only. */
  @Get(':id/preview')
  preview(@Param('id') id: string, @Query('targetId') targetId: string) {
    return this.imported.preview(id, targetId);
  }

  @Post(':id/merge')
  merge(@Param('id') id: string, @Body() dto: MergeImportedDto, @CurrentUser() user: any) {
    return this.imported.merge(id, dto.targetId, user);
  }

  @Patch(':id/email')
  setEmail(@Param('id') id: string, @Body() dto: ExpectedEmailDto, @CurrentUser() user: any) {
    return this.imported.setExpectedEmail(id, dto.email ?? null, user);
  }
}
