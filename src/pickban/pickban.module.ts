import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MlbbModule } from '../mlbb/mlbb.module';
import { PickBanController } from './pickban.controller';
import { PickBanService } from './pickban.service';
import { PickBanSuggestionService } from './pickban-suggestion.service';

@Module({
  imports: [PrismaModule, MlbbModule],
  controllers: [PickBanController],
  providers: [PickBanService, PickBanSuggestionService],
})
export class PickBanModule {}
