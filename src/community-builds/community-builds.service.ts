import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hasPermission } from '../access/permissions';
import { serializeUserCard } from '../users/users.service';
import { CommunityBuildsEvents, CommunityBuildEventType } from './community-builds.events';
import {
  CreateCommunityBuildDto,
  HideCommunityBuildDto,
  ReportCommunityBuildDto,
  UpdateCommunityBuildDto,
} from './dto/community-build.dto';
import {
  assertLikeable,
  assertOwner,
  assertPickable,
  assertPublishable,
  assertQuota,
  assertReportable,
  assertTalentTiers,
  BuildRuleError,
  canView,
  cleanText,
  DAY_MS,
  isOwner,
  LIMITS,
  normalizeItemIds,
  normalizeLane,
  normalizeNotes,
  normalizePage,
  normalizeReportReason,
  normalizeSort,
  normalizeTitle,
  Viewer,
} from './community-builds.rules';

export const MODERATE_PERMISSION = 'builds.moderate';

/** Mongo ObjectId shape: Prisma throws instead of returning null otherwise. */
const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value);

const uniq = <T>(list: T[]): T[] => [...new Set(list)];

interface RequestUser {
  id: string;
  username?: string;
  permissions?: string[];
  roleUser?: string;
}

export interface ListQuery {
  hero?: string;
  lane?: string;
  sort?: string;
  page?: string | number;
  limit?: string | number;
}

type BuildRow = NonNullable<Awaited<ReturnType<PrismaService['communityBuild']['findUnique']>>>;

/**
 * Community builds (#129): players create hero builds from the game catalog,
 * keep them as drafts, publish them; others like and report them; holders of
 * `builds.moderate` hide, unhide or delete them. Admin-curated builds stay in
 * the `builds` module (HeroBuild).
 */
@Injectable()
export class CommunityBuildsService {
  private readonly logger = new Logger('CommunityBuildsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: CommunityBuildsEvents,
  ) {}

  viewerOf(user?: RequestUser | null): Viewer {
    return { id: user?.id ?? null, canModerate: hasPermission(user, MODERATE_PERMISSION) };
  }

  // ---------------------------------------------------------------- reads

  /** Published builds, globally or for a hero (`hero` = Mongo id or Moonton id). */
  async listPublic(query: ListQuery, user?: RequestUser | null) {
    const { page, limit, skip } = normalizePage(query.page, query.limit);
    const sort = normalizeSort(query.sort);
    const where: Record<string, unknown> = { status: 'published' };
    if (query.hero) {
      const hero = await this.findHero(query.hero);
      if (!hero) return { items: [], total: 0, page, limit, hasMore: false, sort };
      where.heroId = hero.id;
    }
    if (query.lane) where.lane = this.rule(() => normalizeLane(query.lane));

    const orderBy =
      sort === 'recent'
        ? [{ publishedAt: 'desc' as const }, { id: 'desc' as const }]
        : [{ likesCount: 'desc' as const }, { publishedAt: 'desc' as const }, { id: 'desc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.communityBuild.findMany({ where, orderBy, skip, take: limit }),
      this.prisma.communityBuild.count({ where }),
    ]);
    return {
      items: await this.hydrate(rows, this.viewerOf(user)),
      total,
      page,
      limit,
      hasMore: skip + rows.length < total,
      sort,
    };
  }

  /** Every build of the signed-in player (drafts, published, hidden). */
  async listMine(user: RequestUser) {
    const rows = await this.prisma.communityBuild.findMany({
      where: { authorId: user.id },
      orderBy: [{ updatedAt: 'desc' }],
    });
    return this.hydrate(rows, this.viewerOf(user));
  }

  async findOne(id: string, user?: RequestUser | null) {
    const viewer = this.viewerOf(user);
    const build = await this.getVisible(id, viewer);
    const [out] = await this.hydrate([build], viewer);
    return out;
  }

  /** Enabled emblem talents grouped by tier, for the build editor. */
  async talents() {
    const rows = await this.prisma.emblemTalent.findMany({ orderBy: [{ tier: 'asc' }, { sort: 'asc' }, { name: 'asc' }] });
    return rows
      .filter((r) => r.enabled !== false && r.tier != null)
      .map((r) => ({ id: r.id, name: r.name, icon: r.icon, description: r.description, tier: r.tier, gameId: r.gameId }));
  }

  // ---------------------------------------------------------------- owner writes

  async create(user: RequestUser, dto: CreateCommunityBuildDto) {
    const owned = await this.prisma.communityBuild.count({ where: { authorId: user.id } });
    this.rule(() => assertQuota(owned, LIMITS.buildsPerUser, 'quota_builds', 'builds in total'));
    const hero = await this.findHero(dto.heroId);
    if (!hero) throw this.badRequest('Unknown hero.', 'hero_unknown');

    const data = await this.normalizeContent(dto, null, !!dto.publish);
    const now = new Date();
    if (dto.publish) await this.assertPublishQuota(user.id);

    const build = await this.prisma.communityBuild.create({
      data: {
        authorId: user.id,
        heroId: hero.id,
        heroGameId: hero.heroId ?? null,
        heroName: hero.name,
        title: data.title,
        notes: data.notes,
        lane: data.lane,
        itemIds: data.itemIds,
        emblemId: data.emblemId,
        talentIds: data.talentIds,
        battleSpellId: data.battleSpellId,
        status: dto.publish ? 'published' : 'draft',
        publishedAt: dto.publish ? now : null,
      },
    });
    if (dto.publish) await this.emit('published', build, user.id);
    return this.findOne(build.id, user);
  }

  async update(id: string, user: RequestUser, dto: UpdateCommunityBuildDto) {
    const build = await this.getOwned(id, user);
    const merged = {
      title: dto.title !== undefined ? dto.title : build.title,
      notes: dto.notes !== undefined ? dto.notes : build.notes,
      lane: dto.lane !== undefined ? dto.lane : build.lane,
      itemIds: dto.itemIds !== undefined ? dto.itemIds : build.itemIds,
      emblemId: dto.emblemId !== undefined ? dto.emblemId : build.emblemId,
      talentIds: dto.talentIds !== undefined ? dto.talentIds : build.talentIds,
      battleSpellId: dto.battleSpellId !== undefined ? dto.battleSpellId : build.battleSpellId,
    };
    // A published build must stay publishable; entries disabled since the
    // build was written may be kept but not newly added.
    const data = await this.normalizeContent(merged, build, build.status === 'published');
    await this.prisma.communityBuild.update({ where: { id: build.id }, data });
    return this.findOne(build.id, user);
  }

  async remove(id: string, user: RequestUser) {
    const build = await this.getOwned(id, user);
    await this.deleteCascade(build.id);
    await this.emit('deleted', build, user.id);
    return { success: true };
  }

  async publish(id: string, user: RequestUser) {
    const build = await this.getOwned(id, user);
    if (build.status === 'hidden') throw this.badRequest('This build was hidden by a moderator.', 'hidden_by_moderator');
    if (build.status === 'published') return this.findOne(build.id, user);
    // Publishing requires every entry to be currently available.
    await this.normalizeContent(build, null, true);
    await this.assertPublishQuota(user.id);
    const updated = await this.prisma.communityBuild.update({
      where: { id: build.id },
      data: { status: 'published', publishedAt: new Date() },
    });
    await this.emit('published', updated, user.id);
    return this.findOne(build.id, user);
  }

  async unpublish(id: string, user: RequestUser) {
    const build = await this.getOwned(id, user);
    if (build.status === 'hidden') throw this.badRequest('This build was hidden by a moderator.', 'hidden_by_moderator');
    if (build.status === 'draft') return this.findOne(build.id, user);
    const updated = await this.prisma.communityBuild.update({ where: { id: build.id }, data: { status: 'draft' } });
    await this.emit('unpublished', updated, user.id);
    return this.findOne(build.id, user);
  }

  // ---------------------------------------------------------------- likes & reports

  /** Idempotent: liking twice keeps one like. */
  async like(id: string, user: RequestUser) {
    const build = await this.getVisible(id, this.viewerOf(user));
    this.rule(() => assertLikeable(build, this.viewerOf(user)));
    let added = false;
    try {
      await this.prisma.communityBuildLike.create({ data: { buildId: build.id, userId: user.id } });
      added = true;
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') throw err;
    }
    const likesCount = await this.syncLikes(build.id);
    if (added) await this.emit('liked', { ...build, likesCount }, user.id);
    return { liked: true, likesCount };
  }

  /** Idempotent: removing a missing like is a no-op. */
  async unlike(id: string, user: RequestUser) {
    const build = await this.getBuild(id);
    const { count } = await this.prisma.communityBuildLike.deleteMany({ where: { buildId: build.id, userId: user.id } });
    const likesCount = count ? await this.syncLikes(build.id) : build.likesCount;
    if (count) await this.emit('unliked', { ...build, likesCount }, user.id);
    return { liked: false, likesCount };
  }

  async report(id: string, user: RequestUser, dto: ReportCommunityBuildDto) {
    const viewer = this.viewerOf(user);
    const build = await this.getVisible(id, viewer);
    this.rule(() => assertReportable(build, viewer));
    const reason = this.rule(() => normalizeReportReason(dto.reason));
    const details = cleanText(dto.details ?? '', true).slice(0, LIMITS.reportDetailsMax) || null;

    const existing = await this.prisma.communityBuildReport.findUnique({
      where: { buildId_reporterId: { buildId: build.id, reporterId: user.id } },
    });
    if (existing?.status === 'open') throw this.badRequest('You already reported this build.', 'already_reported');
    const recent = await this.prisma.communityBuildReport.count({
      where: { reporterId: user.id, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
    });
    this.rule(() => assertQuota(recent, LIMITS.reportsPerDay, 'quota_reports', 'reports'));

    if (existing) {
      await this.prisma.communityBuildReport.update({
        where: { id: existing.id },
        data: { reason, details, status: 'open', resolvedById: null, resolvedAt: null, createdAt: new Date() },
      });
    } else {
      await this.prisma.communityBuildReport.create({
        data: { buildId: build.id, reporterId: user.id, reason, details },
      });
    }
    await this.syncReports(build.id);
    return { reported: true };
  }

  // ---------------------------------------------------------------- moderation

  /**
   * Moderation queue. `filter`: reported (open reports, default), hidden, all
   * (published + hidden). Drafts are private and never listed.
   */
  async moderationList(query: { filter?: string; page?: string | number; limit?: string | number }, user: RequestUser) {
    const { page, limit, skip } = normalizePage(query.page, query.limit);
    const filter = query.filter === 'hidden' || query.filter === 'all' ? query.filter : 'reported';
    const where =
      filter === 'hidden'
        ? { status: 'hidden' }
        : filter === 'all'
          ? { status: { in: ['published', 'hidden'] } }
          : { status: { in: ['published', 'hidden'] }, reportsCount: { gt: 0 } };
    const orderBy =
      filter === 'reported'
        ? [{ reportsCount: 'desc' as const }, { updatedAt: 'desc' as const }]
        : [{ updatedAt: 'desc' as const }];
    const [rows, total] = await Promise.all([
      this.prisma.communityBuild.findMany({ where, orderBy, skip, take: limit }),
      this.prisma.communityBuild.count({ where }),
    ]);
    const items = await this.hydrate(rows, this.viewerOf(user));
    const reports = rows.length
      ? await this.prisma.communityBuildReport.findMany({
          where: { buildId: { in: rows.map((r) => r.id) }, status: 'open' },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const reporters = await this.userCards(reports.map((r) => r.reporterId));
    const byBuild = new Map<string, any[]>();
    for (const r of reports) {
      byBuild.set(r.buildId, [
        ...(byBuild.get(r.buildId) ?? []),
        {
          id: r.id,
          reason: r.reason,
          details: r.details,
          createdAt: r.createdAt,
          reporter: reporters.get(r.reporterId) ?? null,
        },
      ]);
    }
    return {
      items: items.map((b) => ({ ...b, reports: byBuild.get(b.id) ?? [] })),
      total,
      page,
      limit,
      hasMore: skip + rows.length < total,
      filter,
    };
  }

  /** Hides a published build and closes its open reports. Idempotent. */
  async hide(id: string, user: RequestUser, dto: HideCommunityBuildDto) {
    const build = await this.getModeratable(id);
    const reason = cleanText(dto.reason ?? '').slice(0, LIMITS.hideReasonMax) || null;
    if (build.status !== 'hidden') {
      const updated = await this.prisma.communityBuild.update({
        where: { id: build.id },
        data: { status: 'hidden', hiddenAt: new Date(), hiddenById: user.id, hiddenReason: reason },
      });
      await this.closeReports(build.id, 'resolved', user.id);
      await this.log('community_build.hide', user, build, reason);
      await this.emit('hidden', updated, user.id);
    }
    return this.findOne(build.id, user);
  }

  async unhide(id: string, user: RequestUser) {
    const build = await this.getModeratable(id);
    if (build.status === 'hidden') {
      const updated = await this.prisma.communityBuild.update({
        where: { id: build.id },
        data: { status: 'published', hiddenAt: null, hiddenById: null, hiddenReason: null },
      });
      await this.log('community_build.unhide', user, build);
      await this.emit('unhidden', updated, user.id);
    }
    return this.findOne(build.id, user);
  }

  /** Closes the open reports without hiding the build. */
  async dismissReports(id: string, user: RequestUser) {
    const build = await this.getModeratable(id);
    const count = await this.closeReports(build.id, 'dismissed', user.id);
    if (count) await this.log('community_build.dismiss_reports', user, build, `${count} report(s)`);
    return { dismissed: count };
  }

  async moderatorDelete(id: string, user: RequestUser) {
    const build = await this.getModeratable(id);
    await this.deleteCascade(build.id);
    await this.log('community_build.delete', user, build);
    await this.emit('deleted', build, user.id);
    return { success: true };
  }

  // ---------------------------------------------------------------- internals

  /** Runs a pure rule and maps its error to an HTTP error. */
  private rule<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof BuildRuleError) {
        if (err.code === 'not_owner') throw new ForbiddenException({ message: err.message, code: err.code });
        throw this.badRequest(err.message, err.code);
      }
      throw err;
    }
  }

  private badRequest(message: string, code: string) {
    return new BadRequestException({ statusCode: 400, message, code });
  }

  private notFound() {
    return new NotFoundException({ statusCode: 404, message: 'Build not found.', code: 'not_found' });
  }

  private async getBuild(id: string): Promise<BuildRow> {
    if (!isObjectId(id)) throw this.notFound();
    const build = await this.prisma.communityBuild.findUnique({ where: { id } });
    if (!build) throw this.notFound();
    return build;
  }

  /** A build the viewer may see; others look missing (no existence leak). */
  private async getVisible(id: string, viewer: Viewer): Promise<BuildRow> {
    const build = await this.getBuild(id);
    if (!canView(build, viewer)) throw this.notFound();
    return build;
  }

  private async getOwned(id: string, user: RequestUser): Promise<BuildRow> {
    const viewer = this.viewerOf(user);
    const build = await this.getVisible(id, viewer);
    this.rule(() => assertOwner(build, viewer));
    return build;
  }

  /** Moderators act on public or hidden builds, never on private drafts. */
  private async getModeratable(id: string): Promise<BuildRow> {
    const build = await this.getBuild(id);
    if (build.status === 'draft') throw this.notFound();
    return build;
  }

  private async findHero(ref: string) {
    const value = String(ref ?? '').trim();
    if (isObjectId(value)) return this.prisma.hero.findUnique({ where: { id: value } });
    if (/^\d{1,9}$/.test(value)) return this.prisma.hero.findFirst({ where: { heroId: Number(value) } });
    return null;
  }

  private async assertPublishQuota(userId: string) {
    const recent = await this.prisma.communityBuild.count({
      where: { authorId: userId, publishedAt: { gte: new Date(Date.now() - DAY_MS) } },
    });
    this.rule(() => assertQuota(recent, LIMITS.publishesPerDay, 'quota_publish', 'publications'));
  }

  /**
   * Normalizes and validates the editable content against the catalog.
   * `previous` = the stored build (its entries may stay even if disabled since).
   */
  private async normalizeContent(
    input: {
      title?: string | null;
      notes?: string | null;
      lane?: string | null;
      itemIds?: string[] | null;
      emblemId?: string | null;
      talentIds?: string[] | null;
      battleSpellId?: string | null;
    },
    previous: BuildRow | null,
    publishable: boolean,
  ) {
    const title = this.rule(() => normalizeTitle(input.title));
    const notes = this.rule(() => normalizeNotes(input.notes));
    const lane = this.rule(() => normalizeLane(input.lane));
    const itemIds = this.rule(() => normalizeItemIds(input.itemIds ?? []));
    const talentIds = uniq((input.talentIds ?? []).filter(Boolean));
    const emblemId = input.emblemId || null;
    const battleSpellId = input.battleSpellId || null;
    for (const id of [...itemIds, ...talentIds, emblemId, battleSpellId]) {
      if (id && !isObjectId(id)) throw this.badRequest('Invalid catalog id.', 'catalog_id');
    }

    const [items, emblems, spells, talents] = await Promise.all([
      itemIds.length
        ? this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, enabled: true } })
        : [],
      emblemId ? this.prisma.emblem.findMany({ where: { id: emblemId }, select: { id: true, enabled: true } }) : [],
      battleSpellId
        ? this.prisma.battleSpell.findMany({ where: { id: battleSpellId }, select: { id: true, enabled: true } })
        : [],
      talentIds.length
        ? this.prisma.emblemTalent.findMany({
            where: { id: { in: talentIds } },
            select: { id: true, enabled: true, tier: true },
          })
        : [],
    ]);
    const kept = previous
      ? [...previous.itemIds, ...previous.talentIds, previous.emblemId, previous.battleSpellId].filter(
          (v): v is string => !!v,
        )
      : [];
    this.rule(() => {
      assertPickable(itemIds, items, 'item', kept);
      assertPickable(emblemId ? [emblemId] : [], emblems, 'emblem', kept);
      assertPickable(battleSpellId ? [battleSpellId] : [], spells, 'spell', kept);
      assertPickable(talentIds, talents, 'talent', kept);
      assertTalentTiers(talents);
      if (publishable) assertPublishable({ title, itemIds });
    });
    // Talents stored in tier order.
    const tierOf = new Map<string, number>(
      (talents as { id: string; tier: number | null }[]).map((t) => [t.id, t.tier ?? 0]),
    );
    talentIds.sort((a, b) => (tierOf.get(a) ?? 0) - (tierOf.get(b) ?? 0));
    return { title, notes, lane, itemIds, emblemId, talentIds, battleSpellId };
  }

  private async syncLikes(buildId: string): Promise<number> {
    const likesCount = await this.prisma.communityBuildLike.count({ where: { buildId } });
    await this.prisma.communityBuild.update({ where: { id: buildId }, data: { likesCount } });
    return likesCount;
  }

  private async syncReports(buildId: string): Promise<number> {
    const reportsCount = await this.prisma.communityBuildReport.count({ where: { buildId, status: 'open' } });
    await this.prisma.communityBuild.update({ where: { id: buildId }, data: { reportsCount } });
    return reportsCount;
  }

  private async closeReports(buildId: string, status: 'resolved' | 'dismissed', userId: string): Promise<number> {
    const { count } = await this.prisma.communityBuildReport.updateMany({
      where: { buildId, status: 'open' },
      data: { status, resolvedById: userId, resolvedAt: new Date() },
    });
    await this.syncReports(buildId);
    return count;
  }

  private async deleteCascade(buildId: string) {
    await this.prisma.$transaction([
      this.prisma.communityBuildLike.deleteMany({ where: { buildId } }),
      this.prisma.communityBuildReport.deleteMany({ where: { buildId } }),
      this.prisma.communityBuild.delete({ where: { id: buildId } }),
    ]);
  }

  private async emit(type: CommunityBuildEventType, build: BuildRow, actorId: string) {
    await this.events.emit({
      type,
      buildId: build.id,
      heroId: build.heroId,
      authorId: build.authorId,
      actorId,
      likesCount: build.likesCount,
    });
  }

  private async log(action: string, user: RequestUser, build: BuildRow, details?: string | null) {
    try {
      await this.prisma.adminLog.create({
        data: {
          action,
          admin: user.username ?? user.id,
          target: build.id,
          details: [`${build.title} (${build.heroName})`, details].filter(Boolean).join(' - ').slice(0, 500),
        },
      });
    } catch (err) {
      this.logger.warn(`admin log failed: ${(err as Error)?.message}`);
    }
  }

  private async userCards(ids: string[]) {
    const wanted = uniq(ids.filter(isObjectId));
    if (!wanted.length) return new Map<string, any>();
    const users = await this.prisma.user.findMany({ where: { id: { in: wanted } } });
    const cards = new Map<string, any>();
    for (const u of users) {
      const card: any = serializeUserCard(u);
      cards.set(u.id, {
        id: card.id,
        username: card.username,
        displayName: card.displayName,
        avatar: card.avatar,
        equippedFrame: card.equippedFrame ?? null,
      });
    }
    return cards;
  }

  /** Resolves heroes, catalog entries, authors and the viewer's likes in a few queries. */
  private async hydrate(rows: BuildRow[], viewer: Viewer) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const itemIds = uniq(rows.flatMap((r) => r.itemIds)).filter(isObjectId);
    const talentIds = uniq(rows.flatMap((r) => r.talentIds)).filter(isObjectId);
    const emblemIds = uniq(rows.map((r) => r.emblemId).filter(isObjectId));
    const spellIds = uniq(rows.map((r) => r.battleSpellId).filter(isObjectId));
    const heroIds = uniq(rows.map((r) => r.heroId).filter(isObjectId));
    const catalogSelect = { id: true, name: true, icon: true, description: true, enabled: true, gameId: true };

    const [items, emblems, spells, talents, heroes, authors, likes, reports] = await Promise.all([
      itemIds.length ? this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: catalogSelect }) : [],
      emblemIds.length ? this.prisma.emblem.findMany({ where: { id: { in: emblemIds } }, select: catalogSelect }) : [],
      spellIds.length ? this.prisma.battleSpell.findMany({ where: { id: { in: spellIds } }, select: catalogSelect }) : [],
      talentIds.length
        ? this.prisma.emblemTalent.findMany({ where: { id: { in: talentIds } }, select: { ...catalogSelect, tier: true } })
        : [],
      heroIds.length
        ? this.prisma.hero.findMany({
            where: { id: { in: heroIds } },
            select: { id: true, name: true, heroId: true, thumb: true, image: true, roles: true },
          })
        : [],
      this.userCards(rows.map((r) => r.authorId)),
      viewer.id
        ? this.prisma.communityBuildLike.findMany({ where: { userId: viewer.id, buildId: { in: ids } }, select: { buildId: true } })
        : [],
      viewer.id
        ? this.prisma.communityBuildReport.findMany({
            where: { reporterId: viewer.id, buildId: { in: ids }, status: 'open' },
            select: { buildId: true },
          })
        : [],
    ]);
    const map = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
    const itemMap = map(items);
    const emblemMap = map(emblems);
    const spellMap = map(spells);
    const talentMap = map(talents);
    const heroMap = map(heroes);
    const liked = new Set(likes.map((l) => l.buildId));
    const reported = new Set(reports.map((r) => r.buildId));

    return rows.map((r) => {
      const mine = isOwner(r, viewer);
      const privileged = mine || !!viewer.canModerate;
      const hero = heroMap.get(r.heroId);
      return {
        id: r.id,
        title: r.title,
        notes: r.notes,
        lane: r.lane,
        status: r.status,
        likesCount: r.likesCount,
        publishedAt: r.publishedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        hero: {
          id: r.heroId,
          heroId: hero?.heroId ?? r.heroGameId ?? null,
          name: hero?.name ?? r.heroName,
          image: hero?.thumb ?? hero?.image ?? null,
          roles: hero?.roles ?? [],
        },
        author: this.authorOf(r.authorId, authors),
        items: r.itemIds.map((id) => itemMap.get(id)).filter(Boolean),
        emblem: (r.emblemId && emblemMap.get(r.emblemId)) || null,
        talents: r.talentIds.map((id) => talentMap.get(id)).filter(Boolean),
        battleSpell: (r.battleSpellId && spellMap.get(r.battleSpellId)) || null,
        isMine: mine,
        likedByMe: liked.has(r.id),
        reportedByMe: reported.has(r.id),
        // Why a build was hidden: author and moderators only; report counts
        // stay with the moderators.
        ...(privileged ? { hiddenAt: r.hiddenAt, hiddenReason: r.hiddenReason } : {}),
        ...(viewer.canModerate ? { reportsCount: r.reportsCount } : {}),
      };
    });
  }

  private authorOf(authorId: string, authors: Map<string, any>) {
    return authors.get(authorId) ?? { id: authorId, username: null, displayName: null, avatar: null, equippedFrame: null };
  }
}
