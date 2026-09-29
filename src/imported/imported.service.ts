import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlayerStatsService } from '../stats/player-stats.service';
import {
  BLOCKING_COLLECTIONS,
  DROPPED_COLLECTIONS,
  IMPORTED_PROVIDER,
  LEGACY_REGISTRY_BACKUP_KEY,
  LEGACY_REGISTRY_KEY,
  MIN_SUGGESTION_SCORE,
  ProfileLike,
  gamesWouldDuplicate,
  isAdoptedProfile,
  isImportedProfile,
  isPlaceholderEmail,
  matchPlayerConflicts,
  mergeReasons,
  normalizeExpectedEmail,
  placeholderEmailFor,
  planTeamMemberships,
  retargetGames,
  retargetRegistry,
  retargetSeasonSummary,
  suggestTargets,
} from './imported-merge.logic';

/** Signed-in admin performing the operation (for the `AdminLog` entry). */
export type Actor = { id: string; username?: string | null };

const PROFILE_SELECT = {
  id: true,
  username: true,
  email: true,
  avatar: true,
  provider: true,
  googleId: true,
  gameNickname: true,
  mlbbRoleId: true,
  bio: true,
  role: true,
  wins: true,
  losses: true,
  mvpCount: true,
  isSystemAccount: true,
  isBanned: true,
  createdAt: true,
};

/**
 * Admin operations on the profiles created by the legacy import (#153/#154):
 * review them, set the address their owner will sign in with, and merge one
 * into a real member account.
 */
@Injectable()
export class ImportedService {
  private readonly logger = new Logger(ImportedService.name);

  constructor(
    private prisma: PrismaService,
    private playerStats: PlayerStatsService,
  ) {}

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * Every imported profile with what it holds: seasons, teams, matches played
   * and whether an admin already set a real address on it.
   */
  async list() {
    const profiles = await this.prisma.user.findMany({
      where: { provider: IMPORTED_PROVIDER, isSystemAccount: false },
      select: PROFILE_SELECT,
      orderBy: { username: 'asc' },
    });
    if (!profiles.length) return [];
    const ids = profiles.map((p) => p.id);

    const [members, players, awards] = await Promise.all([
      this.prisma.esportTeamMember.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, teamId: true },
      }),
      this.prisma.esportMatchPlayer.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, matchId: true },
      }),
      this.prisma.seasonAward.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, seasonId: true },
      }),
    ]);

    const teams = await this.teamNames(members.map((m) => m.teamId));
    const seasonByMatch = await this.seasonByMatch(players.map((p) => p.matchId));
    const seasons = await this.seasonNames([
      ...Array.from(seasonByMatch.values()).filter(Boolean),
      ...awards.map((a) => a.seasonId),
    ] as string[]);

    return profiles.map((p) => {
      const teamIds = Array.from(new Set(members.filter((m) => m.userId === p.id).map((m) => m.teamId)));
      const matchIds = players.filter((r) => r.userId === p.id).map((r) => r.matchId);
      const seasonIds = Array.from(
        new Set(
          [
            ...matchIds.map((id) => seasonByMatch.get(id) ?? null),
            ...awards.filter((a) => a.userId === p.id).map((a) => a.seasonId),
          ].filter(Boolean) as string[],
        ),
      );
      return {
        ...this.publicProfile(p),
        teams: teamIds.map((id) => ({ id, name: teams.get(id) ?? '?' })),
        seasons: seasonIds.map((id) => ({ id, name: seasons.get(id) ?? '?' })),
        matchesPlayed: matchIds.length,
        awards: awards.filter((a) => a.userId === p.id).length,
      };
    });
  }

  /**
   * Real member accounts a profile may be merged into.
   *
   * With no query this is the suggestion list, and it is scored against EVERY
   * real account, not a first page: the right person is very often not in the
   * first 200 usernames alphabetically. Only the id and the two name columns
   * are read for that pass, and the full payload is fetched for the handful of
   * accounts actually offered.
   *
   * With a query the database does the filtering and the score only orders the
   * rows the admin asked for, so a deliberate search is never hidden by the
   * suggestion floor.
   */
  async candidates(profileId: string, q = '', limit = 20) {
    const profile = await this.loadImported(profileId);
    const query = String(q ?? '').trim();
    const take = Math.min(Math.max(1, limit), 50);
    const real = {
      isSystemAccount: false,
      isBanned: false,
      provider: { not: IMPORTED_PROVIDER },
    };

    if (!query) {
      const all = await this.prisma.user.findMany({
        where: real,
        select: { id: true, username: true, gameNickname: true },
      });
      const best = suggestTargets(profile, all, take, MIN_SUGGESTION_SCORE);
      if (!best.length) return [];
      const rows = await this.prisma.user.findMany({
        where: { id: { in: best.map((b) => b.id) } },
        select: PROFILE_SELECT,
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return best
        .map((b) => {
          const row = byId.get(b.id);
          return row ? { ...this.publicProfile(row), score: b.score, matchedOn: b.matchedOn } : null;
        })
        .filter(Boolean);
    }

    const rows = await this.prisma.user.findMany({
      where: {
        ...real,
        OR: [
          { username: { contains: query, mode: 'insensitive' as const } },
          { gameNickname: { contains: query, mode: 'insensitive' as const } },
          { email: { contains: query, mode: 'insensitive' as const } },
        ],
      },
      select: PROFILE_SELECT,
      orderBy: { username: 'asc' },
      take,
    });
    const scores = new Map(suggestTargets(profile, rows, rows.length, 0).map((x) => [x.id, x]));
    return rows
      .map((r) => ({
        ...this.publicProfile(r),
        score: scores.get(r.id)?.score ?? 0,
        matchedOn: scores.get(r.id)?.matchedOn ?? null,
      }))
      .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * Exactly what a merge would move, drop and refuse. Read-only: the admin
   * page shows it before the confirmation modal, and `merge` recomputes it so
   * the decision is never taken from a stale payload.
   */
  async preview(profileId: string, targetId: string) {
    const { source, target } = await this.loadPair(profileId, targetId);

    const [srcMembers, tgtMembers, srcPlayers, tgtPlayers, awards, staff] = await Promise.all([
      this.prisma.esportTeamMember.findMany({
        where: { userId: source.id },
        select: { id: true, teamId: true, isCaptain: true },
      }),
      this.prisma.esportTeamMember.findMany({
        where: { userId: target.id },
        select: { teamId: true },
      }),
      this.prisma.esportMatchPlayer.findMany({
        where: { userId: source.id },
        select: { id: true, matchId: true, teamId: true },
      }),
      this.prisma.esportMatchPlayer.findMany({
        where: { userId: target.id },
        select: { matchId: true },
      }),
      this.prisma.seasonAward.findMany({
        where: { userId: source.id },
        select: { id: true, seasonId: true, category: true, title: true },
      }),
      this.prisma.esportTeamStaff.findMany({
        where: { userId: source.id },
        select: { id: true, teamId: true, role: true },
      }),
    ]);

    const memberships = planTeamMemberships(srcMembers, tgtMembers.map((m) => m.teamId));
    const conflicts = matchPlayerConflicts(srcPlayers, tgtPlayers.map((p) => p.matchId));

    const matches = await this.matchesReferencing(source.id);
    const picks = matches.reduce(
      (n, m) => n + retargetGames(m.games, source.id, target.id).changed,
      0,
    );
    const duplicatedGames = matches
      .filter((m) => gamesWouldDuplicate(m.games, source.id, target.id))
      .map((m) => m.id);

    const [mvpMatches, mvpTournaments, elections] = await Promise.all([
      this.prisma.esportMatch.count({ where: { mvpUserId: source.id } }),
      this.prisma.tournament.count({ where: { mvpUserId: source.id } }),
      this.prisma.rewardElection.count({ where: { userId: source.id } }),
    ]);

    const blocking = await this.blockingRows(source.id);
    const dropped = await this.droppedRows(source.id);

    const teams = await this.teamNames([
      ...srcMembers.map((m) => m.teamId),
      ...staff.map((s) => s.teamId),
    ]);
    const conflictSeasons = await this.seasonByMatch(conflicts);
    const seasonNames = await this.seasonNames([
      ...(awards.map((a) => a.seasonId) as string[]),
      ...(Array.from(conflictSeasons.values()).filter(Boolean) as string[]),
    ]);

    const registry = await this.registryPlan(source.id, target.id, memberships.drop);
    const summaries = await this.seasonSummaryPlan(source.id, target.id);

    const reasons = mergeReasons(conflicts, duplicatedGames, blocking);

    return {
      source: this.publicProfile(source),
      target: this.publicProfile(target),
      canMerge: reasons.length === 0,
      reasons,
      moves: {
        teamMemberships: memberships.move.map((id) => {
          const row = srcMembers.find((m) => m.id === id)!;
          return { id, teamId: row.teamId, teamName: teams.get(row.teamId) ?? '?', isCaptain: row.isCaptain };
        }),
        droppedTeamMemberships: memberships.drop.map((id) => {
          const row = srcMembers.find((m) => m.id === id)!;
          return { id, teamId: row.teamId, teamName: teams.get(row.teamId) ?? '?' };
        }),
        matchPlayers: srcPlayers.length - conflicts.length,
        awards: awards.map((a) => ({
          id: a.id,
          category: a.category,
          title: a.title,
          seasonName: seasonNames.get(a.seasonId) ?? '?',
        })),
        staff: staff.map((s) => ({ id: s.id, role: s.role, teamName: teams.get(s.teamId) ?? '?' })),
        gamePicks: picks,
        matchMvp: mvpMatches,
        tournamentMvp: mvpTournaments,
        rewardElections: elections,
        registryEntries: registry.legacyIds,
        registryPruned: registry.pruned,
        seasonArchives: summaries.reduce((n, x) => n + x.changed, 0),
      },
      drops: dropped,
      blocking,
      conflicts: conflicts.map((matchId) => ({
        matchId,
        seasonName: seasonNames.get(conflictSeasons.get(matchId) ?? '') ?? null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  /**
   * Move everything the imported profile holds onto `targetId`, delete the
   * placeholder, repoint the import registry and the season archives.
   *
   * The reads and the plan happen first, then a single `$transaction` applies
   * every write (MongoDB replica set): either the whole history moves, or
   * nothing does. The counters of the target are recomputed afterwards with
   * the shared helper, outside of the transaction, because it is derived data
   * that any later match edit recomputes anyway.
   *
   * Idempotent in both directions: every write is a `updateMany` /
   * `deleteMany` filtered on the source id, and replaying the same pair once
   * the placeholder is gone recomputes the target instead of failing, so a
   * process killed between the transaction and the recompute is repaired by
   * simply pressing the button again.
   */
  async merge(profileId: string, targetId: string, actor: Actor) {
    const replay = await this.replayIfAlreadyMerged(profileId, targetId, actor);
    if (replay) return replay;

    const plan = await this.preview(profileId, targetId);
    if (!plan.canMerge) {
      // `reasons` travels with the error so the UI translates it the same way
      // it translates the preview; `message` is only the fallback.
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'merge_refused',
        reasons: plan.reasons,
        message: 'La fusion est refusée : rechargez l’aperçu.',
      });
    }

    const source = plan.source;
    const target = plan.target;
    const p = this.prisma;

    const matches = await this.matchesReferencing(source.id);
    const gameWrites = matches
      .map((m) => ({ id: m.id, ...retargetGames(m.games, source.id, target.id) }))
      .filter((m) => m.changed > 0);

    const droppedMemberIds = plan.moves.droppedTeamMemberships.map((m) => m.id);
    const registry = await this.registryPlan(source.id, target.id, droppedMemberIds);
    const summaries = await this.seasonSummaryPlan(source.id, target.id);

    const ops: any[] = [
      // Team memberships: the rows the target already has win.
      ...droppedMemberIds.map((id) => p.esportTeamMember.delete({ where: { id } })),
      ...plan.moves.teamMemberships.map((m) =>
        p.esportTeamMember.update({ where: { id: m.id }, data: { userId: target.id } }),
      ),
      p.esportMatchPlayer.updateMany({
        where: { userId: source.id },
        data: { userId: target.id },
      }),
      p.seasonAward.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
      p.esportTeamStaff.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
      p.esportMatch.updateMany({ where: { mvpUserId: source.id }, data: { mvpUserId: target.id } }),
      p.tournament.updateMany({ where: { mvpUserId: source.id }, data: { mvpUserId: target.id } }),
      p.rewardElection.updateMany({ where: { userId: source.id }, data: { userId: target.id } }),
      ...gameWrites.map((g) => p.esportMatch.update({ where: { id: g.id }, data: { games: g.value } })),
      // Archived rosters of the closed seasons (`summary.legacy`, written by
      // the import): no foreign key protects them.
      ...summaries.map((x) => p.esportSeason.update({ where: { id: x.id }, data: { summary: x.value } })),
      // Residue of the placeholder: never moved, it describes nothing.
      ...DROPPED_COLLECTIONS.map((c) =>
        (p as any)[c.model].deleteMany({ where: { [c.field]: source.id } }),
      ),
      p.friendship.deleteMany({
        where: { OR: [{ requesterId: source.id }, { addresseeId: source.id }] },
      }),
      ...registry.writes.map((w) =>
        p.appSetting.update({ where: { key: w.key }, data: { value: w.value } }),
      ),
      p.user.delete({ where: { id: source.id } }),
    ];

    try {
      await p.$transaction(ops);
    } catch (err: any) {
      // Another admin merged (or deleted) one of these rows while this plan was
      // being built. Nothing was written: the transaction rolled back.
      const code = err?.code;
      if (code === 'P2025' || code === 'P2034') {
        const still = await this.prisma.user.findUnique({ where: { id: source.id } });
        if (!still) {
          throw new NotFoundException({
            statusCode: 404,
            error: 'Not Found',
            code: 'source_gone',
            message: 'Ce profil importé vient d’être fusionné ou supprimé par quelqu’un d’autre.',
          });
        }
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'merge_raced',
          message:
            'La fusion a été interrompue : les données ont changé pendant l’opération. Rechargez la page et réessayez.',
        });
      }
      throw err;
    }

    await this.playerStats.recomputeUsers([target.id]);

    await this.log(
      'imported.merge',
      actor,
      target.id,
      `Profil importé « ${source.username} » (${source.id}) fusionné dans « ${target.username} » : ` +
        `${plan.moves.teamMemberships.length} appartenance(s), ${plan.moves.matchPlayers} feuille(s) de match, ` +
        `${plan.moves.awards.length} distinction(s), ${plan.moves.gamePicks} pick(s), ` +
        `${summaries.length} archive(s) de saison, ${registry.legacyIds.length} entrée(s) de registre.`,
    );

    const merged = await this.prisma.user.findUnique({
      where: { id: target.id },
      select: PROFILE_SELECT,
    });
    return {
      success: true,
      alreadyMerged: false,
      source,
      target: merged ? this.publicProfile(merged) : target,
      moved: plan.moves,
      dropped: plan.drops,
    };
  }

  /**
   * Retrying a merge whose placeholder is already gone.
   *
   * The transaction and the counter recompute cannot be atomic together (the
   * recompute reads what the transaction just wrote), so a process killed in
   * between leaves a correct database with stale counters on the target. The
   * admin's natural reaction is to press the button again; answering 404 would
   * leave the counters wrong forever. So when the source no longer exists and
   * the target is a usable account, the retry recomputes the target and says
   * the merge had already happened.
   */
  private async replayIfAlreadyMerged(profileId: string, targetId: string, actor: Actor) {
    this.assertObjectId(profileId);
    if (!targetId) throw new BadRequestException('Compte cible manquant.');
    this.assertObjectId(targetId);
    const source = await this.prisma.user.findUnique({ where: { id: profileId } });
    if (source) return null;
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: PROFILE_SELECT,
    });
    if (!target) throw new NotFoundException('Profil introuvable.');
    await this.playerStats.recomputeUsers([target.id]);
    await this.log(
      'imported.merge.replay',
      actor,
      target.id,
      `Fusion rejouée : le profil importé ${profileId} n’existe plus, compteurs de « ${target.username} » recalculés.`,
    );
    const fresh = await this.prisma.user.findUnique({
      where: { id: target.id },
      select: PROFILE_SELECT,
    });
    return {
      success: true,
      alreadyMerged: true,
      source: null,
      target: this.publicProfile(fresh ?? target),
      moved: null,
      dropped: [],
    };
  }

  // -------------------------------------------------------------------------
  // Expected email
  // -------------------------------------------------------------------------

  /**
   * Set (or clear) the address the owner of an imported profile will sign in
   * with. The Google sign-in adopts an account by email
   * (`auth.service.googleLogin`), so writing his Gmail here is what lets him
   * take the profile over without any further admin action.
   */
  async setExpectedEmail(profileId: string, rawEmail: unknown, actor: Actor) {
    const profile = await this.loadImported(profileId);
    if (profile.googleId) {
      throw new ConflictException(
        'Ce profil est déjà rattaché à un compte Google : son adresse appartient à son propriétaire.',
      );
    }
    const email = normalizeExpectedEmail(rawEmail);
    const next = email ?? placeholderEmailFor(profile.username);
    if (next === profile.email.toLowerCase()) {
      return { success: true, unchanged: true, profile: this.publicProfile(profile) };
    }
    // `email` is the unique column, but the Google sign-in resolves an account
    // by `googleId` FIRST and only then by `email`: an address already sitting
    // in somebody's `googleEmail` would land its owner on his own account, and
    // this profile would never be adopted. Both columns are checked.
    const taken = await this.prisma.user.findFirst({
      where: { OR: [{ email: next }, { googleEmail: next }], NOT: { id: profile.id } },
      select: { id: true, username: true },
    });
    if (taken) {
      throw new ConflictException('Cette adresse e-mail est déjà utilisée par un autre compte.');
    }
    const updated = await this.prisma.user.update({
      where: { id: profile.id },
      data: { email: next },
      select: PROFILE_SELECT,
    });
    await this.log(
      'imported.email',
      actor,
      profile.id,
      email
        ? `Adresse attendue de « ${profile.username} » : ${email}.`
        : `Adresse attendue de « ${profile.username} » effacée (retour au domaine importé).`,
    );
    return { success: true, unchanged: false, profile: this.publicProfile(updated) };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Malformed ids would make Prisma throw (500) instead of answering 400. */
  private assertObjectId(id: string) {
    if (!/^[0-9a-f]{24}$/i.test(String(id ?? ''))) {
      throw new BadRequestException('Identifiant invalide.');
    }
  }

  private publicProfile(u: any) {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      avatar: u.avatar ?? null,
      provider: u.provider ?? 'local',
      gameNickname: u.gameNickname ?? null,
      hasGoogle: !!u.googleId,
      hasGameAccount: !!u.mlbbRoleId,
      emailSet: !isPlaceholderEmail(u.email),
      bio: u.bio ?? null,
      lane: u.role ?? null,
      wins: u.wins ?? 0,
      losses: u.losses ?? 0,
      mvpCount: u.mvpCount ?? 0,
      createdAt: u.createdAt ?? null,
    };
  }

  private async loadImported(id: string): Promise<ProfileLike & Record<string, any>> {
    this.assertObjectId(id);
    const user = await this.prisma.user.findUnique({ where: { id }, select: PROFILE_SELECT });
    if (!user) throw new NotFoundException('Profil introuvable.');
    if (!isImportedProfile(user)) {
      throw new BadRequestException('Ce compte n’est pas un profil importé.');
    }
    return user as any;
  }

  private async loadPair(profileId: string, targetId: string) {
    if (!targetId) throw new BadRequestException('Compte cible manquant.');
    this.assertObjectId(targetId);
    if (profileId === targetId) {
      throw new BadRequestException('Le profil importé et le compte cible sont le même compte.');
    }
    const source = await this.loadImported(profileId);
    // A Google or game account means somebody already signed in with this
    // profile: the merge would delete his identity, his XP and his progression
    // (the dropped collections are only residue for an unclaimed placeholder).
    if (source.googleId || source.mlbbRoleId) {
      throw new BadRequestException(
        'Ce profil a déjà été réclamé (compte Google ou compte de jeu) : sa fusion supprimerait la connexion et la progression de son propriétaire.',
      );
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: PROFILE_SELECT,
    });
    if (!target) throw new NotFoundException('Compte cible introuvable.');
    if (target.isSystemAccount) {
      throw new BadRequestException('Un compte technique ne peut pas recevoir un profil importé.');
    }
    if (target.isBanned) {
      throw new BadRequestException('Un compte banni ne peut pas recevoir un profil importé.');
    }
    if (isImportedProfile(target as any) && !isAdoptedProfile(target as any)) {
      throw new BadRequestException(
        'Le compte cible est lui aussi un profil importé non réclamé : fusionnez-le d’abord avec un compte réel.',
      );
    }
    return { source, target };
  }

  /** Matches whose `games` JSON mentions the profile (picks or per-game MVP). */
  private async matchesReferencing(userId: string) {
    return this.prisma.esportMatch.findMany({
      where: { games: { contains: userId } },
      select: { id: true, games: true },
    });
  }

  private async blockingRows(userId: string) {
    const out: { model: string; count: number }[] = [];
    for (const c of BLOCKING_COLLECTIONS) {
      const count = await (this.prisma as any)[c.model].count({ where: { [c.field]: userId } });
      if (count > 0) out.push({ model: c.model, count });
    }
    return out;
  }

  /**
   * Registry writes of a merge: the live mapping and the backup the import
   * keeps next to it. Both are rewritten, otherwise restoring the backup would
   * resurrect the placeholder and take the history back off the real account.
   */
  private async registryPlan(sourceId: string, targetId: string, deletedIds: string[]) {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: [LEGACY_REGISTRY_KEY, LEGACY_REGISTRY_BACKUP_KEY] } },
      select: { key: true, value: true },
    });
    const writes: { key: string; value: string }[] = [];
    const legacyIds = new Set<string>();
    let pruned = 0;
    for (const row of rows) {
      const out = retargetRegistry(row.value, sourceId, targetId, deletedIds);
      if (!out.value) continue;
      writes.push({ key: row.key, value: out.value });
      if (row.key === LEGACY_REGISTRY_KEY) {
        for (const id of out.legacyIds) legacyIds.add(id);
        pruned = out.pruned;
      }
    }
    return { writes, legacyIds: Array.from(legacyIds), pruned };
  }

  /**
   * Season archives mentioning the profile. The import writes the historical
   * roster of every season into `EsportSeason.summary.legacy.rosters` as plain
   * JSON, which no foreign key protects.
   */
  private async seasonSummaryPlan(sourceId: string, targetId: string) {
    const rows = await this.prisma.esportSeason.findMany({
      where: { summary: { contains: sourceId } },
      select: { id: true, name: true, summary: true },
    });
    return rows
      .map((r) => ({ id: r.id, name: r.name, ...retargetSeasonSummary(r.summary, sourceId, targetId) }))
      .filter((r): r is typeof r & { value: string } => !!r.value);
  }

  private async droppedRows(userId: string) {
    const out: { model: string; count: number }[] = [];
    for (const c of DROPPED_COLLECTIONS) {
      const count = await (this.prisma as any)[c.model].count({ where: { [c.field]: userId } });
      if (count > 0) out.push({ model: c.model, count });
    }
    const friendships = await this.prisma.friendship.count({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
    });
    if (friendships > 0) out.push({ model: 'friendship', count: friendships });
    return out;
  }

  private async teamNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (!uniq.length) return new Map();
    const rows = await this.prisma.esportTeam.findMany({
      where: { id: { in: uniq } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async seasonNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (!uniq.length) return new Map();
    const rows = await this.prisma.esportSeason.findMany({
      where: { id: { in: uniq } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async seasonByMatch(ids: string[]): Promise<Map<string, string | null>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (!uniq.length) return new Map();
    const rows = await this.prisma.esportMatch.findMany({
      where: { id: { in: uniq } },
      select: { id: true, seasonId: true },
    });
    return new Map(rows.map((r) => [r.id, r.seasonId ?? null]));
  }

  private async log(action: string, actor: Actor, target?: string, details?: string) {
    try {
      await this.prisma.adminLog.create({
        data: {
          action,
          admin: actor?.username ?? actor?.id ?? 'system',
          target: target ?? null,
          details: details?.slice(0, 500) ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`admin log failed: ${(err as Error)?.message}`);
    }
  }
}
