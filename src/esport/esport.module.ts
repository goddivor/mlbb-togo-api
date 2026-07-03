import { Module } from '@nestjs/common';
import { EsportController } from './esport.controller';
import { EsportService } from './esport.service';

@Module({
  controllers: [EsportController],
  providers: [EsportService],
  exports: [EsportService],
})
export class EsportModule {}
