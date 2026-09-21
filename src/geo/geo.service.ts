import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EsportSeasonsService } from '../esport/esport-seasons.service';
import { OTHER_CITY_ID, OTHER_CITY_NAME, TOGO_CITIES, TOGO_REGIONS } from './geo.constants';
import { MapAggregate, SeasonWindow, aggregateMap } from './geo.logic';
import { PUBLIC_USER_WHERE } from '../users/public-user.filter';

@Injectable()
export class GeoService {
  constructor(
    private prisma: PrismaService,
    private seasons: EsportSeasonsService,
  ) {}

  /** Static gazetteer for the city selects. */
  listCities() {
    return {
      regions: TOGO_REGIONS,
      cities: TOGO_CITIES.map(({ id, name, region, lat, lng }) => ({ id, name, region, lat, lng })),
      other: { id: OTHER_CITY_ID, name: OTHER_CITY_NAME },
    };
  }

  /**
   * Counts per city. `seasonKey` (id, slug or "current") restricts tournaments
   * and events to the season's date window; players and teams are global.
   */
  async getMap(seasonKey?: string): Promise<MapAggregate> {
    const season = await this.resolveSeason(seasonKey);
    const [users, teams, tournaments, events, drafts] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          ...PUBLIC_USER_WHERE,
          city: { not: null },
        },
        select: {
          id: true,
          username: true,
          avatar: true,
          gameNickname: true,
          city: true,
          privacy: true,
          equippedFrame: true,
          fallbackFrame: true,
          equippedFrameExpiresAt: true,
          equippedTitle: true,
        },
        orderBy: { lastActive: 'desc' },
      }),
      this.prisma.esportTeam.findMany({
        where: { city: { not: null } },
        select: { id: true, name: true, image: true, type: true, city: true, _count: { select: { members: true } } },
        orderBy: { sort: 'asc' },
      }),
      this.prisma.tournament.findMany({
        where: { city: { not: null } },
        select: { id: true, name: true, status: true, startDate: true, endDate: true, city: true },
      }),
      this.prisma.event.findMany({
        where: { city: { not: null }, isPublic: true },
        select: { id: true, title: true, type: true, date: true, time: true, city: true },
      }),
      this.prisma.draftTournament.findMany({
        where: { city: { not: null } },
        select: { id: true, name: true, status: true, category: true, city: true },
      }),
    ]);

    return aggregateMap({
      users,
      teams: teams.map((t) => ({ ...t, memberCount: t._count.members })),
      tournaments,
      events,
      drafts,
      season,
    });
  }

  private async resolveSeason(key?: string): Promise<SeasonWindow | null> {
    const k = (key ?? '').trim();
    if (!k || k === 'all') return null;
    try {
      const s = k === 'current' ? await this.seasons.current() : await this.seasons.get(k);
      return { id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate };
    } catch {
      return null;
    }
  }
}
