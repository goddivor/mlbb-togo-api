import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IntegrationsService, Actor } from './integrations.service';
import { IntegrationName, isIntegrationName } from './integrations.logic';
import { UpdateAnthropicDto, UpdateCloudinaryDto } from './dto/integrations.dto';

function integrationOf(name: string): IntegrationName {
  if (!isIntegrationName(name)) throw new NotFoundException(`Intégration inconnue : ${name}`);
  return name;
}

/** Third-party credentials managed from the admin (secrets are write-only). */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('admin.integrations')
@Controller('admin/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  status() {
    return this.integrations.getStatus();
  }

  @Put('anthropic')
  updateAnthropic(@Body() dto: UpdateAnthropicDto, @CurrentUser() user: Actor) {
    return this.integrations.update('anthropic', { ...dto }, user);
  }

  @Put('cloudinary')
  updateCloudinary(@Body() dto: UpdateCloudinaryDto, @CurrentUser() user: Actor) {
    return this.integrations.update('cloudinary', { ...dto }, user);
  }

  @Delete(':name')
  remove(@Param('name') name: string, @CurrentUser() user: Actor) {
    return this.integrations.remove(integrationOf(name), user);
  }

  @Post(':name/test')
  @HttpCode(200)
  test(@Param('name') name: string) {
    return this.integrations.test(integrationOf(name));
  }
}
