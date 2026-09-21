import { Module } from '@nestjs/common';
import { SponsorsController } from './sponsors.controller';
import { SponsorsService } from './sponsors.service';
import { EsportModule } from '../esport/esport.module';
import { CommunityModule } from '../community/community.module';

@Module({
  imports: [EsportModule, CommunityModule],
  controllers: [SponsorsController],
  providers: [SponsorsService],
  exports: [SponsorsService],
})
export class SponsorsModule {}
