import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MediaActor, MediaService } from './media.service';
import { ConfirmUploadDto, ListMediaQueryDto, RejectMediaDto, SignUploadDto } from './dto/media.dto';

/**
 * Image uploads (#131). Flow: `POST /media/sign` -> the browser posts the file
 * straight to Cloudinary with the signed fields -> `POST /media/confirm`.
 * Every endpoint re-checks the purpose permission / ownership.
 */
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('config')
  config() {
    return this.media.publicConfig();
  }

  @Post('sign')
  @HttpCode(200)
  sign(@Body() dto: SignUploadDto, @CurrentUser() user: MediaActor) {
    return this.media.sign(user, dto.purpose, dto.targetId);
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(@Body() dto: ConfirmUploadDto, @CurrentUser() user: MediaActor) {
    return this.media.confirm(user, dto.purpose, dto.targetId, dto.publicId);
  }

  @Get('targets/:purpose/:targetId')
  target(@Param('purpose') purpose: string, @Param('targetId') targetId: string, @CurrentUser() user: MediaActor) {
    return this.media.targetState(user, purpose, targetId);
  }

  @Delete('targets/:purpose/:targetId')
  removeFromTarget(
    @Param('purpose') purpose: string,
    @Param('targetId') targetId: string,
    @CurrentUser() user: MediaActor,
  ) {
    return this.media.removeFromTarget(user, purpose, targetId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: MediaActor) {
    return this.media.deleteAsset(user, id);
  }
}

/** Media library: every tracked upload, moderation of pending images. */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('admin.media')
@Controller('admin/media')
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(@Query() query: ListMediaQueryDto) {
    return this.media.list(query);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @CurrentUser() user: MediaActor) {
    return this.media.approve(user, id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: RejectMediaDto, @CurrentUser() user: MediaActor) {
    return this.media.reject(user, id, dto.reason);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: MediaActor) {
    return this.media.deleteAsset(user, id);
  }
}
