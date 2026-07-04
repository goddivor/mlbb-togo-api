import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { LanesService } from './lanes.service';
import { UpdateLaneDto } from './dto/update-lane.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('lanes')
export class LanesController {
  constructor(private readonly lanes: LanesService) {}

  // ----- Public -----

  @Get()
  findAll() {
    return this.lanes.findAll();
  }

  @Get(':key')
  findByKey(@Param('key') key: string) {
    return this.lanes.findByKey(key);
  }

  // ----- Admin -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch(':key')
  update(@Param('key') key: string, @Body() body: UpdateLaneDto) {
    return this.lanes.update(key, body);
  }
}
