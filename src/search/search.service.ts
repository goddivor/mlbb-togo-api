import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { serializeUserCard } from '../users/users.service';

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  async search(query: SearchQueryDto = {}) {
    const q = (query.q || '').trim();
    const limit = query.limit ?? 5;

    // Empty or single character: return empty groups (no error).
    if (!q || q.length < 2) {
      return {
        users: [],
        heroes: [],
        teams: [],
        tournaments: [],
        events: [],
      };
    }

    // Case-insensitive search patterns (MongoDB regex).
    const pattern = { $regex: q, $options: 'i' };

    // Run all searches in parallel for better performance.
    const [users, heroes, teams, tournaments, events] = await Promise.all([
      this.searchUsers(pattern, limit),
      this.searchHeroes(pattern, limit),
      this.searchTeams(pattern, limit),
      this.searchTournaments(pattern, limit),
      this.searchEvents(pattern, limit),
    ]);

    return { users, heroes, teams, tournaments, events };
  }

  private async searchUsers(pattern: any, limit: number) {
    // Public endpoint: exclude banned users and staff (admin/moderator).
    const users = await this.prisma.user.findMany({
      where: {
        username: pattern,
        isBanned: false,
        roleUser: { notIn: ['admin', 'moderator'] },
      },
      take: limit,
    });

    return users.map(serializeUserCard);
  }

  private async searchHeroes(pattern: any, limit: number) {
    return this.prisma.hero.findMany({
      where: { name: pattern },
      take: limit,
      select: {
        id: true,
        name: true,
        role: true,
        image: true,
        description: true,
      },
    });
  }

  private async searchTeams(pattern: any, limit: number) {
    return this.prisma.team.findMany({
      where: {
        OR: [{ name: pattern }, { tag: pattern }],
      },
      take: limit,
      select: {
        id: true,
        name: true,
        tag: true,
        logo: true,
        description: true,
        region: true,
        wins: true,
        losses: true,
      },
    });
  }

  private async searchTournaments(pattern: any, limit: number) {
    return this.prisma.tournament.findMany({
      where: {
        OR: [{ name: pattern }, { description: pattern }],
      },
      take: limit,
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        startDate: true,
        banner: true,
      },
    });
  }

  private async searchEvents(pattern: any, limit: number) {
    return this.prisma.event.findMany({
      where: {
        OR: [{ title: pattern }, { description: pattern }],
      },
      take: limit,
      select: {
        id: true,
        title: true,
        type: true,
        description: true,
        date: true,
        isPublic: true,
      },
    });
  }
}
