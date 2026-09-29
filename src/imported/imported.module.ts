import { Module } from '@nestjs/common';
import { ImportedController } from './imported.controller';
import { ImportedService } from './imported.service';
import { PlayerStatsModule } from '../stats/player-stats.module';

@Module({
  imports: [PlayerStatsModule],
  controllers: [ImportedController],
  providers: [ImportedService],
  exports: [ImportedService],
})
export class ImportedModule {}
