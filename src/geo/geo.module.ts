import { Module } from '@nestjs/common';
import { EsportModule } from '../esport/esport.module';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

@Module({
  imports: [EsportModule],
  controllers: [GeoController],
  providers: [GeoService],
  exports: [GeoService],
})
export class GeoModule {}
