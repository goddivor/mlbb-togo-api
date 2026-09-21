import { Module } from '@nestjs/common';
import { MlbbController } from './mlbb.controller';
import { MlbbService } from './mlbb.service';
import { GmsClient } from './gms.client';
import { MetaCacheService } from './meta-cache.service';
import { HeroMetaService } from './hero-meta.service';

@Module({
  controllers: [MlbbController],
  providers: [GmsClient, MetaCacheService, MlbbService, HeroMetaService],
  exports: [MlbbService, HeroMetaService, GmsClient, MetaCacheService],
})
export class MlbbModule {}
