import { Module } from '@nestjs/common';
import { EmblemsController } from './emblems.controller';
import { EmblemsService } from './emblems.service';

@Module({
  controllers: [EmblemsController],
  providers: [EmblemsService],
  exports: [EmblemsService],
})
export class EmblemsModule {}
