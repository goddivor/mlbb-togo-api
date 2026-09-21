import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MediaService } from './media.service';
import { AdminMediaController, MediaController } from './media.controller';

@Module({
  imports: [IntegrationsModule],
  providers: [MediaService],
  controllers: [MediaController, AdminMediaController],
  exports: [MediaService],
})
export class MediaModule {}
