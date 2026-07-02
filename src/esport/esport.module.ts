import { Module } from '@nestjs/common';
import { EsportController } from './esport.controller';
import { EsportService } from './esport.service';
import { CommunityModule } from '../community/community.module';

@Module({
  imports: [CommunityModule],
  controllers: [EsportController],
  providers: [EsportService],
  exports: [EsportService],
})
export class EsportModule {}
