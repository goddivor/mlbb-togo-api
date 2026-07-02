import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { EsportService } from './esport.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('esport')
export class EsportController {
  constructor(private readonly esport: EsportService) {}

  // ----- Public -----

  @Get()
  getOrg() {
    return this.esport.getOrg();
  }

  @Get('teams')
  getTeams() {
    return this.esport.getTeams();
  }

  @Get('teams/:id')
  getTeam(@Param('id') id: string) {
    return this.esport.getTeam(id);
  }

  @Get('sponsors')
  getSponsors() {
    return this.esport.getSponsors();
  }

  @Get('mtl')
  getMtl() {
    return this.esport.getMtl();
  }

  // ----- Admin: organisation -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id')
  updateOrg(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateOrg(id, body);
  }

  // ----- Admin: équipes -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('teams')
  createTeam(@Body() body: any) {
    return this.esport.createTeam(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('teams/:id')
  updateTeam(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateTeam(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('teams/:id')
  deleteTeam(@Param('id') id: string) {
    return this.esport.deleteTeam(id);
  }

  // ----- Admin: membres -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('teams/:id/members')
  addMember(@Param('id') id: string, @Body() body: any) {
    return this.esport.addMember(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('teams/:id/members/:userId')
  updateMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: any,
  ) {
    return this.esport.updateMember(id, userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('teams/:id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.esport.removeMember(id, userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('teams/:id/captain')
  setCaptain(@Param('id') id: string, @Body() body: any) {
    return this.esport.setCaptain(id, body.userId);
  }

  // ----- Admin: sponsors -----

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('sponsors')
  createSponsor(@Body() body: any) {
    return this.esport.createSponsor(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('sponsors/:id')
  updateSponsor(@Param('id') id: string, @Body() body: any) {
    return this.esport.updateSponsor(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('sponsors/:id')
  deleteSponsor(@Param('id') id: string) {
    return this.esport.deleteSponsor(id);
  }
}
