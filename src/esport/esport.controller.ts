import { Controller, Get } from '@nestjs/common';
import { EsportService } from './esport.service';

@Controller('esport')
export class EsportController {
  constructor(private readonly esport: EsportService) {}

  @Get()
  getOrg() {
    return this.esport.getOrg();
  }

  @Get('teams')
  getTeams() {
    return this.esport.getTeams();
  }

  @Get('sponsors')
  getSponsors() {
    return this.esport.getSponsors();
  }

  @Get('mtl')
  getMtl() {
    return this.esport.getMtl();
  }
}
