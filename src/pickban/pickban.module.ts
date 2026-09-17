import { Module } from '@nestjs/common';
import { PickBanController } from './pickban.controller';
import { PickBanService } from './pickban.service';
import { PickBanSuggestionService } from './pickban-suggestion.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MlbbModule } from '../mlbb/mlbb.module';
import { HeroesModule } from '../heroes/heroes.module';

@Module({
  imports: [PrismaModule, MlbbModule, HeroesModule],
  controllers: [PickBanController],
  providers: [PickBanService, PickBanSuggestionService],
  exports: [PickBanService],
})
export class PickBanModule {}
