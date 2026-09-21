import { Module } from '@nestjs/common';
import { LanesController } from './lanes.controller';
import { LanesService } from './lanes.service';

@Module({
  controllers: [LanesController],
  providers: [LanesService],
  exports: [LanesService],
})
export class LanesModule {}
