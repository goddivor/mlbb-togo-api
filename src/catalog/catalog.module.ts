import { Module } from '@nestjs/common';
import { MlbbModule } from '../mlbb/mlbb.module';
import { CatalogController } from './catalog.controller';
import { CatalogSyncService } from './catalog-sync.service';
import { CatalogStatsService } from './catalog-stats.service';

@Module({
  imports: [MlbbModule],
  controllers: [CatalogController],
  providers: [CatalogSyncService, CatalogStatsService],
  exports: [CatalogSyncService],
})
export class CatalogModule {}
