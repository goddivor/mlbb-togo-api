import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { GmsClient } from './gms.client';
import { APP_HEROES, GMS_USER_AGENT, SRC, TTL, normalizeLang } from './gms.constants';
import { heroTaxonomy } from './gms.mappers';
import { MetaCacheService } from './meta-cache.service';

export interface HeroIndexEntry {
  name: string | null;
  image: string | null;
  roles: string[];
  lanes: string[];
}

@Injectable()
export class MlbbService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gms: GmsClient,
    private readonly cache: MetaCacheService,
  ) {}

  private readonly logger = new Logger('MlbbService');
  private imageCache = new Map<string, { buffer: Buffer; contentType: string }>();

  async proxyImage(
    url: string,
    width?: number,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new BadRequestException('URL invalide.');
    }
    const allowed = [
      'akmweb.youngjoygame.com',
      'akmwebstatic.yuanzhanapp.com',
      'akmpicture.youngjoygame.com',
    ];
    if (!allowed.includes(host)) {
      throw new BadRequestException('Hôte non autorisé.');
    }

    const targetWidth = width && width > 0 ? Math.min(width, 1280) : 1024;
    const cacheKey = `${url}|${targetWidth}`;
    const cached = this.imageCache.get(cacheKey);
    if (cached) return cached;

    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            'user-agent': GMS_USER_AGENT,
            accept: 'image/avif,image/webp,image/png,image/*,*/*',
          },
        });
        if (!res.ok) {
          lastErr = new Error('status ' + res.status);
          continue;
        }
        const raw = Buffer.from(await res.arrayBuffer());
        const srcType = res.headers.get('content-type') || 'image/png';

        let out: { buffer: Buffer; contentType: string };
        if (srcType.includes('svg')) {

          out = { buffer: raw, contentType: 'image/svg+xml' };
        } else {

          const buffer = await sharp(raw)
            .resize({ width: targetWidth, withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer();
          out = { buffer, contentType: 'image/webp' };
        }

        if (this.imageCache.size > 800) this.imageCache.clear();
        this.imageCache.set(cacheKey, out);
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new NotFoundException(
      `Image indisponible apres 3 essais: ${lastErr?.message ?? 'inconnu'}`,
    );
  }

  // Full Moonton hero list (skills, skins, lore...), cached 24 h in memory + DB.
  // Returns [] when Moonton is unreachable and nothing is cached.
  private async fetchHeroRecords(rawLang = 'en'): Promise<any[]> {
    const lang = normalizeLang(rawLang);
    try {
      return await this.cache.wrap(
        `gms:heroes:${lang}`,
        TTL.heroes,
        async () =>
          (
            await this.gms.callSource(
              APP_HEROES,
              SRC.heroes,
              {
                pageSize: 300,
                pageIndex: 1,
                filters: [],
                sorts: [{ data: { field: 'hero_id', order: 'desc' }, type: 'sequence' }],
                object: [],
              },
              lang,
              { timeoutMs: 30_000 }, // ~1.1 MB payload
            )
          ).records,
        { validate: (records) => records.length > 0 },
      );
    } catch (e: any) {
      this.logger.warn(`Moonton unreachable (heroes): ${e?.message}`);
      return [];
    }
  }

  /** Moonton hero id -> name, portrait, role and lane keys (used to enrich meta). */
  async heroIndex(lang = 'en'): Promise<Map<number, HeroIndexEntry>> {
    const records = await this.fetchHeroRecords(lang);
    const map = new Map<number, HeroIndexEntry>();
    for (const r of records) {
      const s = this.mapSummary(r);
      if (s.heroId == null) continue;
      const tax = heroTaxonomy(r);
      map.set(Number(s.heroId), { name: s.name, image: s.image, roles: tax.roles, lanes: tax.lanes });
    }
    return map;
  }

  private mapSummary(record: any) {
    const d = record?.data ?? {};
    const h = d.hero?.data ?? {};
    return {
      heroId: d.hero_id ?? h.heroid ?? null,
      name: h.name ?? null,
      image: d.head ?? h.head ?? null,
      imageBig: d.head_big ?? null,
      difficulty: h.difficulty != null ? Number(h.difficulty) : null,
      roles: (h.sortlabel ?? []).filter(Boolean),
      lanes: (h.roadsortlabel ?? []).filter(Boolean),
      specialities: (h.speciality ?? []).filter(Boolean),
      abilityShow: (h.abilityshow ?? []).map((x: any) => Number(x)),
    };
  }

  private mapDetail(record: any) {
    const d = record?.data ?? {};
    const h = d.hero?.data ?? {};
    const skills: any[] = [];
    for (const group of h.heroskilllist ?? []) {
      for (const s of group.skilllist ?? []) {
        skills.push({
          id: s.skillid,
          name: s.skillname,
          description: s.skilldesc,
          icon: s.skillicon,
          video: s.skillvideo || null,
          cost: s['skillcd&cost'] || null,
          tags: (s.skilltag ?? []).map((t: any) => ({ name: t.tagname, color: t.tagrgb })),
        });
      }
    }
    const skins = (h.heroskin ?? []).map((sk: any) => ({
      name: sk.skinname ?? sk.name ?? null,
      image: sk.skinpic ?? sk.painting ?? sk.skinhead ?? null,
    }));
    return {
      ...this.mapSummary(record),
      story: h.story ?? null,
      tale: h.tale ?? null,
      painting: d.painting ?? h.painting ?? null,
      recommendLabel: h.recommendlevellabel ?? null,
      skills,
      skins,
    };
  }

  async getHeroes(limit?: number, lang = 'en') {
    const records = await this.fetchHeroRecords(lang);
    const mapped = records.map((r) => this.mapSummary(r));
    const sliced = limit && limit > 0 ? mapped.slice(0, limit) : mapped;
    return { total: records.length, heroes: sliced };
  }

  async getLatestHeroes(count = 6, lang = 'en') {
    // Serve OUR database cache first; live fallback only if empty.
    const cached = await this.readCachedShowcase(count);
    if (cached.length) return cached;
    const { heroes } = await this.getHeroes(count, lang);
    return heroes;
  }

  // Reads heroes (non-null art prioritized) from our database and maps them
  // into a shape close to mapShowcase. Returns [] if no art is cached.
  private async readCachedShowcase(count: number) {
    const rows = await this.prisma.hero.findMany({
      where: { art: { not: null } },
      orderBy: [{ heroId: 'desc' }, { name: 'asc' }],
      take: count,
    });
    return rows.map((h) => ({
      heroId: h.heroId,
      name: h.name,
      art: h.art,
      thumb: h.thumb ?? h.image,
      image: h.image,
      roles: h.roles ?? [],
      lanes: h.laneKeys ?? [],
      laneKeys: h.laneKeys ?? [],
      stats: h.stats ?? null,
    }));
  }

  private mapShowcase(record: any) {
    const d = record?.data ?? {};
    const h = d.hero?.data ?? {};
    const skills: any[] = [];
    for (const group of h.heroskilllist ?? []) {
      for (const s of group.skilllist ?? []) {
        if (s.skillicon) skills.push({ name: s.skillname, icon: s.skillicon });
      }
    }
    const ability = (h.abilityshow ?? []).map((x: any) => Number(x) || 0);
    return {
      heroId: d.hero_id ?? h.heroid ?? null,
      name: h.name ?? null,

      art: d.painting ?? d.head_big ?? d.head ?? h.head ?? null,
      thumb: d.head ?? h.squarehead ?? h.head ?? null,
      roles: (h.sortlabel ?? []).filter(Boolean),
      lanes: (h.roadsortlabel ?? []).filter(Boolean),
      specialities: (h.speciality ?? []).filter(Boolean),

      stats: {
        durability: ability[0] ?? 0,
        offense: ability[1] ?? 0,
        ability: ability[2] ?? 0,
        difficulty: ability[3] ?? 0,
      },
      skills: skills.slice(0, 4),
    };
  }

  async getShowcaseHeroes(count = 6, lang = 'en') {
    // Serve OUR database cache first; live fallback only if empty.
    const cached = await this.readCachedShowcase(count);
    if (cached.length) return cached;
    return this.getShowcaseHeroesLive(count, lang);
  }

  // Always live from Moonton (used by the cache refresh).
  async getShowcaseHeroesLive(count = 6, lang = 'en') {
    const records = await this.fetchHeroRecords(lang);
    return records.slice(0, count).map((r) => this.mapShowcase(r));
  }

  async getHero(heroId: number, lang = 'en') {
    const records = await this.fetchHeroRecords(lang);
    const rec = records.find((r) => {
      const id = r?.data?.hero_id ?? r?.data?.hero?.data?.heroid;
      return Number(id) === Number(heroId);
    });
    if (!rec) {
      throw new NotFoundException(`Héros ${heroId} introuvable.`);
    }
    return this.mapDetail(rec);
  }
}
