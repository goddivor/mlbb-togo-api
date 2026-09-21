import { Controller, Get, Query } from '@nestjs/common';
import { GeoService } from './geo.service';

/** Public endpoints backing the Togo map (issue #70). */
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** GET /geo/cities : static list of Togolese cities (+ regions). */
  @Get('cities')
  cities() {
    return this.geo.listCities();
  }

  /** GET /geo/map?seasonId=<id|slug|current> : counts per city. */
  @Get('map')
  map(@Query('seasonId') seasonId?: string) {
    return this.geo.getMap(seasonId);
  }
}
