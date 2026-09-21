import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { HeroMetaService } from '../mlbb/hero-meta.service';
import { parseJson, toJson } from '../common/utils/json.util';
import {
  CreatePickBanDraftDto,
  SuggestPickBanDto,
  SuggestPickBanResponseDto,
  UpdatePickBanStepDto,
} from './dto/pickban.dto';
import {
  HeroCandidate,
  PickBanSuggestionService,
  PickedHeroMeta,
  toPickedMeta,
} from './pickban-suggestion.service';
import {
  DraftOrderError,
  DraftState,
  TeamState,
  applyAction,
  emptyTeam,
  isComplete,
  isMode,
  stepAt,
  totalSteps,
  undoAction,
  usedHeroIds,
} from './pickban-order';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const META_TTL_MS = 60 * 60 * 1000; // 1 hour
const META_FAIL_TTL_MS = 5 * 60 * 1000; // retry Moonton sooner after a failure

interface MetaCacheEntry {
  meta: PickedHeroMeta | null;
  expiresAt: number;
}

interface HeroRates {
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
}

@Injectable()
export class PickBanService {
  private readonly logger = new Logger('PickBanService');
  // Keyed by our Hero id.
  private readonly metaCache = new Map<string, MetaCacheEntry>();
  // Win/pick/ban rates keyed by Moonton hero id (one ranking call, cached).
  private ratesCache: { rates: Map<number, HeroRates>; expiresAt: number } | null = null;

  constructor(
    private prisma: PrismaService,
    private heroMeta: HeroMetaService,
    private suggestion: PickBanSuggestionService,
  ) {}

  /* ---------- Hero catalogue ---------- */

  // Heroes with the fields the draft board needs (lanes, thumbs, rates).
  async listHeroes(): Promise<HeroCandidate[]> {
    return this.loadCandidates();
  }

  private async loadCandidates(): Promise<Array<HeroCandidate & { heroId: number | null }>> {
    const [rows, rates] = await Promise.all([
      this.prisma.hero.findMany({ orderBy: { name: 'asc' } }),
      this.getRates(),
    ]);
    return rows.map((h) => this.toCandidate(h, rates));
  }

  private toCandidate(
    h: any,
    rates: Map<number, HeroRates>,
  ): HeroCandidate & { heroId: number | null } {
    const heroId = h.heroId != null ? Number(h.heroId) : null;
    const r = heroId != null ? rates.get(heroId) : undefined;
    // `stats` may carry rates when cached from the showcase; ranking wins.
    const stats = (h.stats ?? {}) as any;
    return {
      id: h.id,
      heroId,
      name: h.name,
      image: h.image ?? null,
      thumb: h.thumb ?? h.image ?? null,
      role: h.role ?? null,
      roles: h.roles ?? [],
      laneKeys: h.laneKeys ?? [],
      winRate: r?.winRate ?? this.pct(stats.winRate),
      pickRate: r?.pickRate ?? this.pct(stats.pickRate),
      banRate: r?.banRate ?? this.pct(stats.banRate),
    };
  }

  // Current win/pick/ban rates (%) from the Moonton ranking (all ranks, 1 day).
  // Empty map when Moonton is unavailable so the board still works.
  private async getRates(): Promise<Map<number, HeroRates>> {
    if (this.ratesCache && this.ratesCache.expiresAt > Date.now()) return this.ratesCache.rates;
    const rates = new Map<number, HeroRates>();
    try {
      const res = await this.heroMeta.getRanking({ rank: 'all', days: 1 });
      for (const r of res.heroes) {
        rates.set(r.heroId, { winRate: r.winRate, pickRate: r.pickRate, banRate: r.banRate });
      }
      this.ratesCache = { rates, expiresAt: Date.now() + META_TTL_MS };
    } catch (err) {
      this.logger.warn(`Hero ranking unavailable: ${(err as Error).message}`);
      this.ratesCache = { rates, expiresAt: Date.now() + META_FAIL_TTL_MS };
    }
    return rates;
  }

  // Stored stats may carry fractions (0.52) or percentages; normalize to %.
  private pct(n: any): number | null {
    if (typeof n !== 'number' || Number.isNaN(n)) return null;
    return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
  }

  /* ---------- CRUD ---------- */

  async create(userId: string, dto: CreatePickBanDraftDto) {
    const mode = dto.mode ?? 'ranked';
    if (!isMode(mode)) throw new BadRequestException('Invalid draft mode.');
    const name = (dto.name ?? '').trim().slice(0, 60) || 'Untitled draft';
    const draft = await this.prisma.pickBanDraft.create({
      data: {
        name,
        mode,
        shareCode: await this.uniqueShareCode(),
        ownerId: userId,
        blueTeam: toJson(emptyTeam()),
        redTeam: toJson(emptyTeam()),
        currentStep: 0,
        status: 'active',
      },
    });
    return this.serialize(draft);
  }

  async getById(id: string) {
    if (!OBJECT_ID.test(id)) throw new NotFoundException('Draft not found.');
    const draft = await this.prisma.pickBanDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException('Draft not found.');
    return this.serialize(draft);
  }

  async getByShareCode(code: string) {
    const draft = await this.prisma.pickBanDraft.findUnique({
      where: { shareCode: code.toUpperCase() },
    });
    if (!draft) throw new NotFoundException('Draft not found.');
    return this.serialize(draft);
  }

  async listMine(userId: string) {
    const drafts = await this.prisma.pickBanDraft.findMany({
      where: { ownerId: userId },
      orderBy: { updatedAt: 'desc' },
    });
    return drafts.map((d) => this.serialize(d));
  }

  async updateStep(id: string, userId: string, dto: UpdatePickBanStepDto) {
    const draft = await this.getOwned(id, userId);
    const hero = await this.prisma.hero.findUnique({ where: { id: dto.heroId } });
    if (!hero) throw new BadRequestException('Hero not found.');

    const state = this.toState(draft);
    let next: DraftState;
    try {
      next = applyAction(state, {
        action: dto.action,
        team: dto.team,
        heroId: hero.id,
        heroName: hero.name,
        lane: dto.action === 'pick' ? dto.lane : undefined,
      });
    } catch (err) {
      if (err instanceof DraftOrderError) throw new BadRequestException(err.message);
      throw err;
    }
    return this.persistState(id, next);
  }

  async undo(id: string, userId: string) {
    const draft = await this.getOwned(id, userId);
    const state = this.toState(draft);
    if (state.currentStep === 0) throw new BadRequestException('Nothing to undo.');
    return this.persistState(id, undoAction(state));
  }

  async reset(id: string, userId: string) {
    const draft = await this.getOwned(id, userId);
    return this.persistState(id, {
      mode: draft.mode as DraftState['mode'],
      currentStep: 0,
      blueTeam: emptyTeam(),
      redTeam: emptyTeam(),
    });
  }

  async deleteDraft(id: string, userId: string) {
    await this.getOwned(id, userId);
    await this.prisma.pickBanDraft.delete({ where: { id } });
    return { success: true };
  }

  /* ---------- Suggestions ---------- */

  async suggestNext(dto: SuggestPickBanDto): Promise<SuggestPickBanResponseDto> {
    if (!isMode(dto.mode)) throw new BadRequestException('Invalid draft mode.');
    const step = stepAt(dto.mode, Number(dto.currentStep));
    if (!step) throw new BadRequestException('Draft already complete.');

    const state: DraftState = {
      mode: dto.mode,
      currentStep: dto.currentStep,
      blueTeam: this.sanitizeTeam(dto.blueTeam),
      redTeam: this.sanitizeTeam(dto.redTeam),
    };

    const heroes = await this.loadCandidates();
    const byMoontonId = new Map<number, string>();
    for (const h of heroes) if (h.heroId != null) byMoontonId.set(h.heroId, h.id);
    const known = new Set(heroes.map((h) => h.id));

    const allyTeam = step.team === 'blue' ? state.blueTeam : state.redTeam;
    const allyPicks = allyTeam.picks.map((p) => p.heroId).filter((id) => known.has(id));
    // Explicit lanes so a hero played off-lane covers the lane actually chosen.
    const allyLanes: Record<string, string | undefined> = {};
    for (const p of allyTeam.picks) if (p.lane) allyLanes[p.heroId] = p.lane;
    const enemyPicks = (step.team === 'blue' ? state.redTeam : state.blueTeam).picks
      .map((p) => p.heroId)
      .filter((id) => known.has(id));

    const pickedMeta = new Map<string, PickedHeroMeta>();
    const heroById = new Map(heroes.map((h) => [h.id, h]));
    await Promise.all(
      [...new Set([...allyPicks, ...enemyPicks])].map(async (id) => {
        const meta = await this.getPickedMeta(heroById.get(id)!, byMoontonId);
        if (meta) pickedMeta.set(id, meta);
      }),
    );
    const metaAvailable = pickedMeta.size > 0 || allyPicks.length + enemyPicks.length === 0;

    const suggestions = this.suggestion.suggest(heroes, {
      action: step.action,
      team: step.team,
      allyPicks,
      enemyPicks,
      excluded: usedHeroIds(state),
      allyLanes,
      pickedMeta,
      metaAvailable,
    });

    return { suggestions, action: step.action, team: step.team, metaAvailable };
  }

  // Full matchup matrix of one hero on the board (every enemy and every
  // teammate, Academy), mapped to OUR hero ids and cached per hero id.
  // Returns null when Moonton is unavailable (graceful degradation).
  private async getPickedMeta(
    hero: HeroCandidate & { heroId: number | null },
    byMoontonId: Map<number, string>,
  ): Promise<PickedHeroMeta | null> {
    if (hero.heroId == null) return null;
    const cached = this.metaCache.get(hero.id);
    if (cached && cached.expiresAt > Date.now()) return cached.meta;

    try {
      const m = await this.heroMeta.getMatchups(hero.heroId, { rank: 'all' });
      const meta = toPickedMeta(hero.id, m.counters, m.teammates, byMoontonId);
      if (!meta) throw new Error('empty matchup matrix');
      this.metaCache.set(hero.id, { meta, expiresAt: Date.now() + META_TTL_MS });
      return meta;
    } catch (err) {
      this.logger.warn(`Meta unavailable for ${hero.name}: ${(err as Error).message}`);
      this.metaCache.set(hero.id, { meta: null, expiresAt: Date.now() + META_FAIL_TTL_MS });
      return null;
    }
  }

  /* ---------- Helpers ---------- */

  private async getOwned(id: string, userId: string) {
    if (!OBJECT_ID.test(id)) throw new NotFoundException('Draft not found.');
    const draft = await this.prisma.pickBanDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException('Draft not found.');
    if (draft.ownerId !== userId) throw new ForbiddenException('Not the draft owner.');
    return draft;
  }

  private toState(draft: any): DraftState {
    return {
      mode: draft.mode,
      currentStep: draft.currentStep,
      blueTeam: parseJson<TeamState>(draft.blueTeam, emptyTeam()),
      redTeam: parseJson<TeamState>(draft.redTeam, emptyTeam()),
    };
  }

  private sanitizeTeam(team: any): TeamState {
    const picks = Array.isArray(team?.picks) ? team.picks : [];
    const bans = Array.isArray(team?.bans) ? team.bans : [];
    return {
      picks: picks
        .filter((p: any) => typeof p?.heroId === 'string')
        .map((p: any) => ({ heroId: p.heroId, heroName: p.heroName ?? '', lane: p.lane })),
      bans: bans
        .filter((b: any) => typeof b?.heroId === 'string')
        .map((b: any) => ({ heroId: b.heroId, heroName: b.heroName ?? '' })),
    };
  }

  private async persistState(id: string, state: DraftState) {
    const updated = await this.prisma.pickBanDraft.update({
      where: { id },
      data: {
        blueTeam: toJson(state.blueTeam),
        redTeam: toJson(state.redTeam),
        currentStep: state.currentStep,
        status: isComplete(state) ? 'completed' : 'active',
      },
    });
    return this.serialize(updated);
  }

  private serialize(draft: any) {
    return {
      id: draft.id,
      name: draft.name,
      mode: draft.mode,
      shareCode: draft.shareCode,
      ownerId: draft.ownerId,
      blueTeam: parseJson<TeamState>(draft.blueTeam, emptyTeam()),
      redTeam: parseJson<TeamState>(draft.redTeam, emptyTeam()),
      currentStep: draft.currentStep,
      totalSteps: isMode(draft.mode) ? totalSteps(draft.mode) : 0,
      status: draft.status,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };
  }

  private async uniqueShareCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
      const exists = await this.prisma.pickBanDraft.findUnique({ where: { shareCode: code } });
      if (!exists) return code;
    }
    return crypto.randomBytes(6).toString('hex').toUpperCase();
  }
}
