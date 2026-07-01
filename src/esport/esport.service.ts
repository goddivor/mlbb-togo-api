import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EsportService {
  constructor(private prisma: PrismaService) {}

  async getOrg() {
    return this.prisma.esport.findFirst({
      include: { teams: { orderBy: { sort: 'asc' } } },
    });
  }

  async getTeams() {
    return this.prisma.esportTeam.findMany({ orderBy: { sort: 'asc' } });
  }

  async getSponsors() {
    return this.prisma.sponsor.findMany({ orderBy: { sort: 'asc' } });
  }

  async getMtl() {
    return this.prisma.mtl.findFirst({
      include: { images: { orderBy: { sort: 'asc' } } },
    });
  }
}
