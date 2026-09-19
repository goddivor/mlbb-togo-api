import { Module } from '@nestjs/common';
import { BattleSpellsController } from './battle-spells.controller';
import { BattleSpellsService } from './battle-spells.service';

@Module({
  controllers: [BattleSpellsController],
  providers: [BattleSpellsService],
  exports: [BattleSpellsService],
})
export class BattleSpellsModule {}
