import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBuildDto, UpdateBuildDto } from './dto/build.dto';

/** Mongo ObjectId shape: Prisma throws instead of returning null otherwise. */
const isObjectId = (value: string) => /^[0-9a-f]{24}$/i.test(value);

/** A reference removed from the catalog must not break reading a build. */
const safe = <T>(promise: any, fallback: T): Promise<T> =>
  Promise.resolve(promise).catch(() => fallback);

@Injectable()
export class BuildsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get all builds for a specific hero.
   * Returns builds with resolved item objects, emblem and battle spell.
   */
  async findByHero(heroRef: string) {
    const hero = await this.resolveHero(heroRef);
    const builds = await this.prisma.heroBuild.findMany({
      where: { heroId: hero.id },
      orderBy: [{ priority: 'desc' }, { sort: 'asc' }],
    });
    return Promise.all(builds.map((b) => this.enrichBuild(b)));
  }

  /**
   * Get a single build with resolved items, emblem, and battle spell.
   */
  async findOne(buildId: string) {
    if (!isObjectId(buildId)) throw new NotFoundException('Build not found.');
    const build = await this.prisma.heroBuild.findUnique({
      where: { id: buildId },
    });
    if (!build) throw new NotFoundException('Build not found.');
    return this.enrichBuild(build);
  }

  /**
   * Create a new build for a hero.
   */
  async create(heroRef: string, data: CreateBuildDto) {
    const hero = await this.resolveHero(heroRef);
    await this.assertReferencesExist(data);

    const build = await this.prisma.heroBuild.create({
      data: {
        heroId: hero.id,
        heroName: hero.name,
        name: data.name || undefined,
        description: data.description || undefined,
        itemIds: data.itemIds || [],
        emblemId: data.emblemId || undefined,
        battleSpellId: data.battleSpellId || undefined,
        priority: data.priority ?? 0,
        sort: data.sort ?? 0,
      },
    });
    return this.enrichBuild(build);
  }

  /**
   * Update a build.
   */
  async update(buildId: string, data: UpdateBuildDto) {
    await this.findOne(buildId);
    await this.assertReferencesExist(data);
    const build = await this.prisma.heroBuild.update({
      where: { id: buildId },
      data: {
        name: data.name !== undefined ? data.name : undefined,
        description: data.description !== undefined ? data.description : undefined,
        itemIds: data.itemIds !== undefined ? data.itemIds : undefined,
        emblemId: data.emblemId !== undefined ? data.emblemId : undefined,
        battleSpellId: data.battleSpellId !== undefined ? data.battleSpellId : undefined,
        priority: data.priority !== undefined ? data.priority : undefined,
        sort: data.sort !== undefined ? data.sort : undefined,
      },
    });
    return this.enrichBuild(build);
  }

  /**
   * Delete a build.
   */
  async delete(buildId: string) {
    await this.findOne(buildId);
    await this.prisma.heroBuild.delete({ where: { id: buildId } });
    return { success: true };
  }


  /**
   * Accepts either a Mongo ObjectId or the Moonton numeric hero id, which is
   * what the hero detail modal carries.
   */
  private async resolveHero(ref: string) {
    const hero = isObjectId(ref)
      ? await this.prisma.hero.findUnique({ where: { id: ref } })
      : /^\d+$/.test(ref)
        ? await this.prisma.hero.findFirst({ where: { heroId: Number(ref) } })
        : null;
    if (!hero) throw new NotFoundException('Hero not found.');
    return hero;
  }

  /** Referenced items, emblem and spell must exist before the row is written. */
  private async assertReferencesExist(data: CreateBuildDto | UpdateBuildDto) {
    const itemIds = data.itemIds ?? [];
    if (itemIds.length) {
      const found = await this.prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true },
      });
      if (found.length !== new Set(itemIds).size) {
        throw new BadRequestException('Unknown item in itemIds.');
      }
    }
    if (data.emblemId) {
      const emblem = await this.prisma.emblem.findUnique({ where: { id: data.emblemId } });
      if (!emblem) throw new BadRequestException('Unknown emblem.');
    }
    if (data.battleSpellId) {
      const spell = await this.prisma.battleSpell.findUnique({
        where: { id: data.battleSpellId },
      });
      if (!spell) throw new BadRequestException('Unknown battle spell.');
    }
  }

  /**
   * Enrich a build with resolved item objects, emblem, and battle spell.
   */
  private async enrichBuild(build: any) {
    const itemIds: string[] = (build.itemIds || []).filter(isObjectId);
    const [found, emblem, battleSpell] = await Promise.all([
      safe<any[]>(this.prisma.item.findMany({ where: { id: { in: itemIds } } }), []),
      build.emblemId
        ? safe(this.prisma.emblem.findUnique({ where: { id: build.emblemId } }), null)
        : null,
      build.battleSpellId
        ? safe(this.prisma.battleSpell.findUnique({ where: { id: build.battleSpellId } }), null)
        : null,
    ]);
    // `in` queries return DB order: restore the build order (duplicates kept).
    const byId = new Map((found ?? []).map((it) => [it.id, it]));
    const items = itemIds.map((id) => byId.get(id)).filter(Boolean);

    return {
      id: build.id,
      heroId: build.heroId,
      heroName: build.heroName,
      name: build.name,
      description: build.description,
      priority: build.priority,
      sort: build.sort,
      items,
      emblem,
      battleSpell,
      createdAt: build.createdAt,
      updatedAt: build.updatedAt,
    };
  }
}
