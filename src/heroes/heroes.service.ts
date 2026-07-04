import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MlbbService } from '../mlbb/mlbb.service';

// Class (role) -> recommended lanes mapping. Used to derive laneKeys
// from a hero's first class during the MLBB refresh.
const CLASS_TO_LANES: Record<string, string[]> = {
  marksman: ['gold'],
  mage: ['mid'],
  assassin: ['jungle'],
  fighter: ['exp', 'jungle'],
  tank: ['roam', 'exp'],
  support: ['roam'],
};

@Injectable()
export class HeroesService {
  constructor(
    private prisma: PrismaService,
    private mlbb: MlbbService,
  ) {}

  async findAll(role?: string) {
    return this.prisma.hero.findMany({
      where: role ? { role } : undefined,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        role: true,
        image: true,
        description: true,
      },
    });
  }

  async findOne(id: string) {
    const hero = await this.prisma.hero.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        role: true,
        image: true,
        description: true,
      },
    });
    if (!hero) throw new NotFoundException('Héros introuvable.');
    return hero;
  }

  // ----- MLBB cache -----

  // Fetches the full hero list via the Moonton API and upserts (by `name`)
  // our Hero table, so the DB cache can be served afterwards.
  async refreshFromMlbb(): Promise<{ updated: number }> {
    // Base list (name, roles, image, heroId) + showcase (art, thumb, stats).
    const [{ heroes }, showcase] = await Promise.all([
      this.mlbb.getHeroes(),
      this.mlbb.getShowcaseHeroesLive(300),
    ]);

    // Index showcase data by name (art/thumb/stats).
    const showcaseByName = new Map<string, any>();
    for (const s of showcase) {
      if (s?.name) showcaseByName.set(String(s.name).toLowerCase(), s);
    }

    let updated = 0;
    for (const h of heroes) {
      const name: string | null = h?.name ?? null;
      if (!name) continue;

      const classes: string[] = (h.roles ?? [])
        .map((r: string) => String(r).toLowerCase())
        .filter(Boolean);
      const firstClass = classes[0] ?? null;
      const laneKeys = firstClass ? CLASS_TO_LANES[firstClass] ?? [] : [];

      const extra = showcaseByName.get(name.toLowerCase());
      const art: string | null = extra?.art ?? null;
      const thumb: string | null = extra?.thumb ?? h.image ?? null;
      const stats = extra?.stats ?? undefined;

      const data: Record<string, unknown> = {
        role: firstClass ?? 'unknown',
        roles: classes,
        laneKeys,
        image: h.image ?? extra?.thumb ?? null,
        art,
        thumb,
        heroId: h.heroId ?? extra?.heroId ?? null,
        source: 'mlbb',
        syncedAt: new Date(),
      };
      if (stats !== undefined) data.stats = stats;

      await this.prisma.hero.upsert({
        where: { name },
        create: { name, ...(data as any) },
        update: data as any,
      });
      updated++;
    }

    return { updated };
  }

  // Featured heroes served from OUR database (non-null art prioritized).
  async getShowcase(count = 6) {
    return this.readCachedHeroes(count);
  }

  // Latest heroes served from OUR database (same data as the showcase).
  async getLatest(count = 6) {
    return this.readCachedHeroes(count);
  }

  // Reads heroes from the database and maps them into a shape close to
  // mlbb.getShowcaseHeroes. Prioritizes those with a non-null `art` (splash).
  private async readCachedHeroes(count: number) {
    const withArt = await this.prisma.hero.findMany({
      where: { art: { not: null } },
      orderBy: [{ heroId: 'desc' }, { name: 'asc' }],
      take: count,
    });

    let rows = withArt;
    if (rows.length < count) {
      const fill = await this.prisma.hero.findMany({
        where: { art: null },
        orderBy: [{ heroId: 'desc' }, { name: 'asc' }],
        take: count - rows.length,
      });
      rows = [...rows, ...fill];
    }

    return rows.map((h) => ({
      heroId: h.heroId,
      name: h.name,
      art: h.art,
      thumb: h.thumb ?? h.image,
      image: h.image,
      roles: h.roles ?? [],
      laneKeys: h.laneKeys ?? [],
      stats: h.stats ?? null,
    }));
  }
}
