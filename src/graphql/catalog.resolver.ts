import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { PrismaService } from '../prisma/prisma.service';
import {
  EsportOrgModel,
  EsportTeamModel,
  HeroModel,
  LaneModel,
  SponsorModel,
} from './models';

// Résolveur de lecture du catalogue. Toutes les données viennent de NOTRE
// base (cache MLBB rempli par le seed + le refresh admin), ce qui évite de
// solliciter l'API Moonton à chaque requête de la landing/du dashboard.
@Resolver()
export class CatalogResolver {
  constructor(private readonly prisma: PrismaService) {}

  @Query(() => [HeroModel], { description: 'Tous les héros (cache).' })
  heroes(@Args('role', { nullable: true }) role?: string) {
    return this.prisma.hero.findMany({
      where: role ? { role } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  @Query(() => [HeroModel], { description: 'Héros mis en avant (avec splash art).' })
  showcaseHeroes(
    @Args('count', { type: () => Int, nullable: true, defaultValue: 6 }) count: number,
  ) {
    return this.prisma.hero.findMany({
      where: { art: { not: null } },
      take: count,
      orderBy: [{ syncedAt: 'desc' }, { name: 'asc' }],
    });
  }

  @Query(() => [HeroModel], { description: 'Derniers héros synchronisés.' })
  latestHeroes(
    @Args('count', { type: () => Int, nullable: true, defaultValue: 6 }) count: number,
  ) {
    return this.prisma.hero.findMany({
      take: count,
      orderBy: [{ syncedAt: 'desc' }, { name: 'asc' }],
    });
  }

  @Query(() => [LaneModel], { description: 'Les 5 lanes.' })
  lanes() {
    return this.prisma.lane.findMany({ orderBy: { sort: 'asc' } });
  }

  @Query(() => LaneModel, { nullable: true })
  lane(@Args('key') key: string) {
    return this.prisma.lane.findUnique({ where: { key } });
  }

  @Query(() => [SponsorModel])
  sponsors() {
    return this.prisma.sponsor.findMany({ orderBy: { sort: 'asc' } });
  }

  @Query(() => [EsportTeamModel], { description: 'Équipes esport (filtre par type optionnel).' })
  esportTeams(@Args('type', { nullable: true }) type?: string) {
    return this.prisma.esportTeam.findMany({
      where: type ? { type } : undefined,
      orderBy: { sort: 'asc' },
    });
  }

  @Query(() => EsportOrgModel, { nullable: true, description: "L'organisation esport et ses équipes." })
  esportOrg() {
    return this.prisma.esport.findFirst({
      include: { teams: { orderBy: { sort: 'asc' } } },
    });
  }
}
