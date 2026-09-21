import { Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { orUnavailable } from '../mlbb/gms-http.util';
import { CatalogSyncService } from './catalog-sync.service';
import { CatalogStatsService } from './catalog-stats.service';

@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalogSync: CatalogSyncService,
    private readonly catalogStats: CatalogStatsService,
  ) {}

  // Imports items, emblems and battle spells (icons, descriptions) from Moonton.
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('admin.catalog')
  @Post('sync')
  sync() {
    return orUnavailable(this.catalogSync.sync(), 'The Moonton catalog is temporarily unavailable.');
  }

  // ----- Public catalog pages (enabled entries only) -----
  // Statistics come from the cached Academy builds of every hero; rank:
  // all|epic|legend|mythic|honor|glory, lane: exp|mid|roam|jungle|gold.
  // When Moonton is unavailable the lists are still served (`available: false`).

  // Items with recipe metadata (category, tier, builds from / into). Database only.
  @Get('items')
  items() {
    return this.catalogStats.listItems();
  }

  // Item pairs most often found in the same top build. `item` = Moonton item id.
  @Get('items/synergies')
  synergies(
    @Query('rank') rank?: string,
    @Query('lane') lane?: string,
    @Query('item') item?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogStats.synergies({ rank, lane, item, limit });
  }

  // Heroes whose top builds contain the item. `gameId` = Moonton item id.
  @Get('items/:gameId/heroes')
  itemHeroes(
    @Param('gameId', ParseIntPipe) gameId: number,
    @Query('rank') rank?: string,
    @Query('lane') lane?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogStats.itemHeroes(gameId, { rank, lane, limit });
  }

  @Get('spells')
  spells(
    @Query('rank') rank?: string,
    @Query('lane') lane?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogStats.spells({ rank, lane, limit });
  }

  @Get('emblems')
  emblems(
    @Query('rank') rank?: string,
    @Query('lane') lane?: string,
    @Query('limit') limit?: string,
  ) {
    return this.catalogStats.emblems({ rank, lane, limit });
  }
}
