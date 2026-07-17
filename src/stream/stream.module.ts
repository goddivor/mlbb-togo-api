import { Module } from '@nestjs/common';
import { StreamService } from './stream.service';
import { YoutubeOAuthService } from './youtube-oauth.service';
import { StreamController } from './stream.controller';

@Module({
  controllers: [StreamController],
  providers: [StreamService, YoutubeOAuthService],
  exports: [StreamService, YoutubeOAuthService],
})
export class StreamModule {}
