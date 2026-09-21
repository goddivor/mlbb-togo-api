import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { IntegrationsService } from '../integrations/integrations.service';
import { AiClient, AiClientResolver } from './ai-llm';

/**
 * Builds the Anthropic client from the key managed in the admin integrations
 * (env `ANTHROPIC_API_KEY` as fallback). The SDK client is reused as long as
 * the key does not change.
 */
@Injectable()
export class AnthropicClientProvider implements AiClientResolver {
  private readonly logger = new Logger('AiClient');
  private current: { apiKey: string; client: Anthropic } | null = null;
  private lastMode: 'llm' | 'heuristic' | null = null;

  constructor(private readonly integrations: IntegrationsService) {}

  async resolve(): Promise<AiClient> {
    const { config, model } = await this.integrations.resolveAnthropic();
    const mode = config ? 'llm' : 'heuristic';
    if (mode !== this.lastMode) {
      if (config) this.logger.log(`Anthropic client ready (model ${model}).`);
      else this.logger.warn('No Anthropic API key configured: AI endpoints run in heuristic mode.');
      this.lastMode = mode;
    }
    if (!config) {
      this.current = null;
      return { client: null, model };
    }
    if (this.current?.apiKey !== config.apiKey) {
      this.current = {
        apiKey: config.apiKey,
        client: new Anthropic({ apiKey: config.apiKey, maxRetries: 1, timeout: 60_000 }),
      };
    }
    return { client: this.current.client, model };
  }
}
