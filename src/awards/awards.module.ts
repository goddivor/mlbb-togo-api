import { Module } from '@nestjs/common';
import { EsportModule } from '../esport/esport.module';
import { StandingsModule } from '../standings/standings.module';
import { AwardsController } from './awards.controller';
import { AwardsService } from './awards.service';

@Module({
  imports: [EsportModule, StandingsModule],
  controllers: [AwardsController],
  providers: [AwardsService],
  exports: [AwardsService],
})
export class AwardsModule {}
