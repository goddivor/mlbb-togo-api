import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { MlbbModule } from '../mlbb/mlbb.module';
import { ANTHROPIC_CLIENT } from './ai-llm';

@Module({
  imports: [MlbbModule],
  providers: [
    {
      // Null when the key is missing: the service then runs in heuristic mode.
      provide: ANTHROPIC_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY')?.trim();
        return apiKey ? new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 }) : null;
      },
    },
    AiService,
  ],
  controllers: [AiController],
  exports: [AiService],
})
export class AiModule {}
