import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { MlbbModule } from '../mlbb/mlbb.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { GamificationModule } from '../gamification/gamification.module';
import { AI_CLIENT_RESOLVER } from './ai-llm';
import { AnthropicClientProvider } from './ai-client.provider';

@Module({
  imports: [MlbbModule, IntegrationsModule, GamificationModule],
  providers: [
    AnthropicClientProvider,
    { provide: AI_CLIENT_RESOLVER, useExisting: AnthropicClientProvider },
    AiService,
  ],
  controllers: [AiController],
  exports: [AiService],
})
export class AiModule {}
