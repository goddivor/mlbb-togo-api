import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SponsorsService } from './sponsors.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateSponsorOfferDto, UpdateSponsorOfferDto } from './dto/sponsor-offer.dto';
import {
  CreateSponsorshipRequestDto,
  UpdateSponsorshipRequestDto,
} from './dto/sponsorship-request.dto';
import { RateLimiter, clientIp } from './sponsors.logic';
import { REQUEST_RATE_LIMIT } from './sponsors.constants';

@Controller('sponsors')
export class SponsorsController {
  private readonly limiter = new RateLimiter(REQUEST_RATE_LIMIT.max, REQUEST_RATE_LIMIT.windowMs);

  constructor(private readonly sponsors: SponsorsService) {}

  /** GET /sponsors?seasonId=<id|slug|current> : active sponsors, tiered. */
  @Get()
  list(@Query('seasonId') seasonId?: string) {
    return this.sponsors.listPublic(seasonId);
  }

  @Get('offers')
  offers() {
    return this.sponsors.listOffers(false);
  }

  /** GET /sponsors/faq?lang=fr|en */
  @Get('faq')
  faq(@Query('lang') lang?: string) {
    return this.sponsors.getFaq(lang);
  }

  /** Public partnership form (rate-limited per IP). */
  @Post('requests')
  createRequest(@Req() req: any, @Body() dto: CreateSponsorshipRequestDto) {
    if (!this.limiter.hit(clientIp(req)))
      throw new HttpException(
        'Trop de demandes envoyées. Réessayez dans quelques minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    return this.sponsors.createRequest(dto);
  }

  // ----- Admin -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get('all')
  listAll() {
    return this.sponsors.listAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get('offers/all')
  allOffers() {
    return this.sponsors.listOffers(true);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('offers')
  createOffer(@Body() dto: CreateSponsorOfferDto) {
    return this.sponsors.createOffer(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('offers/:id')
  updateOffer(@Param('id') id: string, @Body() dto: UpdateSponsorOfferDto) {
    return this.sponsors.updateOffer(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('offers/:id')
  deleteOffer(@Param('id') id: string) {
    return this.sponsors.deleteOffer(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Get('requests')
  listRequests(@Query('status') status?: string) {
    return this.sponsors.listRequests(status);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @Patch('requests/:id')
  updateRequest(@Param('id') id: string, @Body() dto: UpdateSponsorshipRequestDto) {
    return this.sponsors.updateRequest(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('requests/:id')
  deleteRequest(@Param('id') id: string) {
    return this.sponsors.deleteRequest(id);
  }
}
