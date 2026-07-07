import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { PrismaService } from '../prisma/prisma.service';
import {
  EsportOrgModel,
  EsportTeamModel,
  HeroModel,
  HeroRoleModel,
  LaneModel,
  SponsorModel,
} from './models';

// Catalog read resolver. All data comes from OUR database
// (MLBB cache filled by the seed + admin refresh), which avoids
// calling the Moonton API on every landing/dashboard request.
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

  @Query(() => [HeroRoleModel], { description: 'Les 6 rôles/classes de héros (icônes).' })
  heroRoles() {
    return this.prisma.heroRole.findMany({ orderBy: { sort: 'asc' } });
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
