import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MlbbService } from '../mlbb/mlbb.service';

// Mapping classe (role) -> lanes recommandées. Sert à déduire laneKeys
// à partir de la première classe d'un héros lors du refresh MLBB.
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

  // ----- Cache MLBB -----

  // Récupère la liste complète des héros via l'API Moonton et met à jour
  // (upsert par `name`) notre table Hero, afin de servir ensuite le cache DB.
  async refreshFromMlbb(): Promise<{ updated: number }> {
    // Liste de base (name, roles, image, heroId) + showcase (art, thumb, stats).
    const [{ heroes }, showcase] = await Promise.all([
      this.mlbb.getHeroes(),
      this.mlbb.getShowcaseHeroesLive(300),
    ]);

    // Index des données showcase par nom (art/thumb/stats).
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

  // Héros vedettes servis depuis NOTRE base (art non nul en priorité).
  async getShowcase(count = 6) {
    return this.readCachedHeroes(count);
  }

  // Derniers héros servis depuis NOTRE base (mêmes données que le showcase).
  async getLatest(count = 6) {
    return this.readCachedHeroes(count);
  }

  // Lit des héros depuis la base et les mappe dans une forme proche de
  // mlbb.getShowcaseHeroes. Priorise ceux ayant un `art` (splash) non nul.
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
