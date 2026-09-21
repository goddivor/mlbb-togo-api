import { Module } from '@nestjs/common';
import { MlbbModule } from '../mlbb/mlbb.module';
import { CatalogController } from './catalog.controller';
import { CatalogSyncService } from './catalog-sync.service';

@Module({
  imports: [MlbbModule],
  controllers: [CatalogController],
  providers: [CatalogSyncService],
  exports: [CatalogSyncService],
})
export class CatalogModule {}
