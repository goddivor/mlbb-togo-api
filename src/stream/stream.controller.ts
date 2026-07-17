import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { StreamService } from './stream.service';
import { UpdateStreamConfigDto } from './dto/update-stream-config.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('stream')
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  // Public: the Stream page reads the channel + video list to render.
  @Get('config')
  getConfig() {
    return this.streamService.getConfig();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch('config')
  updateConfig(@Body() dto: UpdateStreamConfigDto) {
    return this.streamService.updateConfig(dto);
  }
}
