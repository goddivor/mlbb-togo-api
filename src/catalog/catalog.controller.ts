import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { orUnavailable } from '../mlbb/gms-http.util';
import { CatalogSyncService } from './catalog-sync.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogSync: CatalogSyncService) {}

  // Imports items, emblems and battle spells (icons, descriptions) from Moonton.
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Post('sync')
  sync() {
    return orUnavailable(this.catalogSync.sync());
  }
}
