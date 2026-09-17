import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MlbbService } from '../mlbb/mlbb.service';
import { HeroesService } from '../heroes/heroes.service';
import { CreatePickBanDraftDto } from './dto/create-pick-ban-draft.dto';
import { UpdatePickBanStepDto } from './dto/update-pick-ban-step.dto';
import {
  SuggestPickBanDto,
  SuggestPickBanResponseDto,
} from './dto/suggest-pick-ban.dto';
import { PickBanSuggestionService } from './pickban-suggestion.service';
import { parseJson, toJson } from '../common/utils/json.util';
import * as crypto from 'crypto';

/**
 * MLBB draft order (Blue bans first):
 * Ranked (3 bans/side):
 *   0-2: Blue bans, 3-5: Red bans, 6-10: Picks alternate B-R-B-R-B
 *
 * Tournament (5 bans/side):
 *   0-4: Blue bans, 5-9: Red bans, 10-19: Picks alternate B-R-B-R-B (5 per side)
 */
const DRAFT_ORDERS = {
  ranked: {
    bans: 3,
    picks: 5,
    totalSteps: 16,
    order: [
      // 0-2: Blue bans
      { step: 0, action: 'ban', team: 'blue' },
      { step: 1, action: 'ban', team: 'blue' },
      { step: 2, action: 'ban', team: 'blue' },
      // 3-5: Red bans
      { step: 3, action: 'ban', team: 'red' },
      { step: 4, action: 'ban', team: 'red' },
      { step: 5, action: 'ban', team: 'red' },
      // 6-15: Picks (alternate)
      { step: 6, action: 'pick', team: 'blue' },
      { step: 7, action: 'pick', team: 'red' },
      { step: 8, action: 'pick', team: 'blue' },
      { step: 9, action: 'pick', team: 'red' },
      { step: 10, action: 'pick', team: 'blue' },
      { step: 11, action: 'pick', team: 'red' },
      { step: 12, action: 'pick', team: 'blue' },
      { step: 13, action: 'pick', team: 'red' },
      { step: 14, action: 'pick', team: 'blue' },
      { step: 15, action: 'pick', team: 'red' },
    ],
  },
  tournament: {
    bans: 5,
    picks: 5,
    totalSteps: 20,
    order: [
      // 0-4: Blue bans
      { step: 0, action: 'ban', team: 'blue' },
      { step: 1, action: 'ban', team: 'blue' },
      { step: 2, action: 'ban', team: 'blue' },
      { step: 3, action: 'ban', team: 'blue' },
      { step: 4, action: 'ban', team: 'blue' },
      // 5-9: Red bans
      { step: 5, action: 'ban', team: 'red' },
      { step: 6, action: 'ban', team: 'red' },
      { step: 7, action: 'ban', team: 'red' },
      { step: 8, action: 'ban', team: 'red' },
      { step: 9, action: 'ban', team: 'red' },
      // 10-19: Picks (alternate)
      { step: 10, action: 'pick', team: 'blue' },
      { step: 11, action: 'pick', team: 'red' },
      { step: 12, action: 'pick', team: 'blue' },
      { step: 13, action: 'pick', team: 'red' },
      { step: 14, action: 'pick', team: 'blue' },
      { step: 15, action: 'pick', team: 'red' },
      { step: 16, action: 'pick', team: 'blue' },
      { step: 17, action: 'pick', team: 'red' },
      { step: 18, action: 'pick', team: 'blue' },
      { step: 19, action: 'pick', team: 'red' },
    ],
  },
};

interface TeamState {
  picks: Array<{ heroId: string; heroName: string; lane?: string }>;
  bans: Array<{ heroId: string; heroName: string }>;
}

@Injectable()
export class PickBanService {
  private metaCache: Map<number, { data: any; expiresAt: number }> = new Map();
  private readonly META_TTL = 60 * 60 * 1000; // 1 hour

  constructor(
    private prisma: PrismaService,
    private mlbb: MlbbService,
    private heroes: HeroesService,
    private suggestion: PickBanSuggestionService,
  ) {}

  /* ---------- CRUD ---------- */

  async create(userId: string, dto: CreatePickBanDraftDto) {
    const shareCode = this.generateShareCode();
    const draft = await this.prisma.pickBanDraft.create({
      data: {
        name: dto.name || 'Untitled Draft',
        mode: dto.mode || 'ranked',
        shareCode,
        ownerId: userId,
        blueTeam: toJson({ picks: [], bans: [] }),
        redTeam: toJson({ picks: [], bans: [] }),
        currentStep: 0,
        status: 'active',
      },
    });
    return this.serialize(draft);
  }

  async getById(id: string, userId?: string) {
    const draft = await this.prisma.pickBanDraft.findUnique({
      where: { id },
    });
    if (!draft) throw new NotFoundException('Draft not found.');

    // Public read allowed; write only for owner
    if (userId && draft.ownerId !== userId) {
      // Still allow read
    }

    return this.serialize(draft);
  }

  async getByShareCode(code: string) {
    const draft = await this.prisma.pickBanDraft.findUnique({
      where: { shareCode: code },
    });
    if (!draft) throw new NotFoundException('Draft not found.');
    return this.serialize(draft);
  }

  async listMine(userId: string) {
    const drafts = await this.prisma.pickBanDraft.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return drafts.map((d) => this.serialize(d));
  }

  async updateStep(id: string, userId: string, dto: UpdatePickBanStepDto) {
    const draft = await this.prisma.pickBanDraft.findUnique({
      where: { id },
    });
    if (!draft) throw new NotFoundException('Draft not found.');
    if (draft.ownerId !== userId)
      throw new ForbiddenException('Not the draft owner.');

    // Validate against draft order
    const config = DRAFT_ORDERS[draft.mode as keyof typeof DRAFT_ORDERS];
    if (!config) throw new BadRequestException('Invalid draft mode.');
    if (draft.currentStep >= config.totalSteps)
      throw new BadRequestException('Draft already complete.');

    const expectedStep = config.order[draft.currentStep];
    if (!expectedStep)
      throw new BadRequestException('Invalid step in draft order.');

    if (expectedStep.action !== dto.action) {
      throw new BadRequestException(
        `Step ${draft.currentStep} expects ${expectedStep.action}, not ${dto.action}.`,
      );
    }
    if (expectedStep.team !== dto.team) {
      throw new BadRequestException(
        `Step ${draft.currentStep} is for ${expectedStep.team} team, not ${dto.team}.`,
      );
    }

    // Validate hero exists and is not already used
    const hero = await this.prisma.hero.findUnique({ where: { id: dto.heroId } });
    if (!hero) throw new BadRequestException('Hero not found.');

    const blueTeam = parseJson<TeamState>(draft.blueTeam, { picks: [], bans: [] });
    const redTeam = parseJson<TeamState>(draft.redTeam, { picks: [], bans: [] });

    const usedHeroIds = new Set([
      ...blueTeam.picks.map((p) => p.heroId),
      ...blueTeam.bans.map((b) => b.heroId),
      ...redTeam.picks.map((p) => p.heroId),
      ...redTeam.bans.map((b) => b.heroId),
    ]);

    if (usedHeroIds.has(dto.heroId))
      throw new BadRequestException('Hero already used.');

    // Add to team
    const targetTeam = dto.team === 'blue' ? blueTeam : redTeam;
    if (dto.action === 'pick') {
      targetTeam.picks.push({
        heroId: dto.heroId,
        heroName: hero.name,
        lane: dto.lane,
      });
    } else {
      targetTeam.bans.push({
        heroId: dto.heroId,
        heroName: hero.name,
      });
    }

    // Advance to next step
    const updated = await this.prisma.pickBanDraft.update({
      where: { id },
      data: {
        blueTeam: toJson(blueTeam),
        redTeam: toJson(redTeam),
        currentStep: draft.currentStep + 1,
        status:
          draft.currentStep + 1 >= config.totalSteps ? 'completed' : 'active',
      },
    });

    return this.serialize(updated);
  }

  async reset(id: string, userId: string) {
    const draft = await this.prisma.pickBanDraft.findUnique({
      where: { id },
    });
    if (!draft) throw new NotFoundException('Draft not found.');
    if (draft.ownerId !== userId)
      throw new ForbiddenException('Not the draft owner.');

    const updated = await this.prisma.pickBanDraft.update({
      where: { id },
      data: {
        blueTeam: toJson({ picks: [], bans: [] }),
        redTeam: toJson({ picks: [], bans: [] }),
        currentStep: 0,
        status: 'active',
      },
    });

    return this.serialize(updated);
  }

  async deleteDraft(id: string, userId: string) {
    const draft = await this.prisma.pickBanDraft.findUnique({
      where: { id },
    });
    if (!draft) throw new NotFoundException('Draft not found.');
    if (draft.ownerId !== userId)
      throw new ForbiddenException('Not the draft owner.');

    await this.prisma.pickBanDraft.delete({ where: { id } });
    return { success: true };
  }

  /* ---------- Suggestions ---------- */

  async suggestNext(dto: SuggestPickBanDto): Promise<SuggestPickBanResponseDto> {
    const config = DRAFT_ORDERS[dto.mode as keyof typeof DRAFT_ORDERS];
    if (!config) throw new BadRequestException('Invalid draft mode.');

    // Get all heroes with meta
    const allHeroes = await this.prisma.hero.findMany();
    const heroMap = new Map(allHeroes.map((h) => [h.id, h]));

    // Determine current action/team
    if (dto.currentStep >= config.totalSteps) {
      throw new BadRequestException('Draft already complete.');
    }
    const expectedStep = config.order[dto.currentStep];
    if (!expectedStep)
      throw new BadRequestException('Invalid step in draft order.');

    // Build hero counter cache (with TTL fallback)
    const heroCounters = await this.buildCounterCache(allHeroes, heroMap);

    // Prepare scoring context
    const allPickedHeroIds = new Set([
      ...dto.blueTeam.picks.map((p) => p.heroId),
      ...dto.redTeam.picks.map((p) => p.heroId),
    ]);
    const allBannedHeroIds = new Set([
      ...dto.blueTeam.bans.map((b) => b.heroId),
      ...dto.redTeam.bans.map((b) => b.heroId),
    ]);

    const bluePickedHeroIds = dto.blueTeam.picks.map((p) => p.heroId);
    const redPickedHeroIds = dto.redTeam.picks.map((p) => p.heroId);

    const uncoveredLanes = new Set(['gold', 'mid', 'jungle', 'exp', 'roam']);
    if (expectedStep.action === 'pick' && expectedStep.team === 'blue') {
      for (const pick of dto.blueTeam.picks) {
        if (pick.lane) uncoveredLanes.delete(pick.lane);
      }
    } else if (expectedStep.action === 'pick' && expectedStep.team === 'red') {
      for (const pick of dto.redTeam.picks) {
        if (pick.lane) uncoveredLanes.delete(pick.lane);
      }
    }

    const availableHeroes = allHeroes.map((h) => ({
      id: h.id,
      name: h.name,
      image: h.image || undefined,
      thumb: h.thumb || undefined,
      role: h.role || undefined,
      laneKeys: h.laneKeys || [],
      stats: h.stats ? (h.stats as any) : undefined,
    }));

    const suggestions = this.suggestion.suggestHeroes(availableHeroes, heroCounters, {
      action: expectedStep.action as 'pick' | 'ban',
      team: expectedStep.team as 'blue' | 'red',
      pickedHeroIds: allPickedHeroIds,
      bannedHeroIds: allBannedHeroIds,
      allyPicks:
        expectedStep.team === 'blue' ? bluePickedHeroIds : redPickedHeroIds,
      enemyPicks:
        expectedStep.team === 'blue' ? redPickedHeroIds : bluePickedHeroIds,
      allyBans: dto[expectedStep.team === 'blue' ? 'blueTeam' : 'redTeam'].bans.map(
        (b) => b.heroId,
      ),
      enemyBans: dto[expectedStep.team === 'blue' ? 'redTeam' : 'blueTeam'].bans.map(
        (b) => b.heroId,
      ),
      uncoveredLanes,
    });

    return {
      suggestions,
      action: expectedStep.action as 'pick' | 'ban',
      team: expectedStep.team as 'blue' | 'red',
    };
  }

  /* ---------- Helpers ---------- */

  private async buildCounterCache(
    allHeroes: any[],
    heroMap: Map<string, any>,
  ): Promise<Map<string, any>> {
    const cache = new Map<string, any>();

    for (const hero of allHeroes) {
      if (!hero.heroId) continue;

      let meta = this.metaCache.get(hero.heroId);
      if (!meta || meta.expiresAt < Date.now()) {
        try {
          // Fetch from Moonton API via MlbbService (with cache)
          const fetched = await this.mlbb.getHeroMeta(hero.heroId);
          meta = { data: fetched, expiresAt: Date.now() + this.META_TTL };
          this.metaCache.set(hero.heroId, meta);
        } catch {
          // Graceful fallback: use empty meta
          meta = { data: {}, expiresAt: Date.now() + this.META_TTL };
          this.metaCache.set(hero.heroId, meta);
        }
      }

      const data = meta.data;
      const strong = (data.counters?.strong ?? [])
        .map((c: any) => {
          // Map hero name from counter data to hero ID
          const matchedHero = Array.from(heroMap.values()).find(
            (h: any) => h.name.toLowerCase() === c.name?.toLowerCase(),
          );
          return matchedHero?.id;
        })
        .filter(Boolean);

      const weak = (data.counters?.weak ?? [])
        .map((c: any) => {
          const matchedHero = Array.from(heroMap.values()).find(
            (h: any) => h.name.toLowerCase() === c.name?.toLowerCase(),
          );
          return matchedHero?.id;
        })
        .filter(Boolean);

      const bestTeammates = (data.synergy?.best ?? [])
        .map((s: any) => {
          const matchedHero = Array.from(heroMap.values()).find(
            (h: any) => h.name.toLowerCase() === s.name?.toLowerCase(),
          );
          return matchedHero?.id;
        })
        .filter(Boolean);

      cache.set(hero.id, {
        heroId: hero.id,
        strong: strong.length > 0 ? strong : undefined,
        weak: weak.length > 0 ? weak : undefined,
        bestTeammates: bestTeammates.length > 0 ? bestTeammates : undefined,
      });
    }

    return cache;
  }

  private serialize(draft: any) {
    return {
      id: draft.id,
      name: draft.name,
      mode: draft.mode,
      shareCode: draft.shareCode,
      ownerId: draft.ownerId,
      blueTeam: parseJson(draft.blueTeam, { picks: [], bans: [] }),
      redTeam: parseJson(draft.redTeam, { picks: [], bans: [] }),
      currentStep: draft.currentStep,
      status: draft.status,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };
  }

  private generateShareCode(): string {
    // Generate a short unique code (6 chars alphanumeric)
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }
}
