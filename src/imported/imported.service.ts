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
  LEGACY_REGISTRY_KEY,
  ProfileLike,
  gamesWouldDuplicate,
  isAdoptedProfile,
  isImportedProfile,
  isPlaceholderEmail,
  matchPlayerConflicts,
  normalizeExpectedEmail,
  placeholderEmailFor,
  planTeamMemberships,
  retargetGames,
  retargetRegistryPlayers,
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

  /** Real member accounts a profile may be merged into (search by text). */
  async candidates(profileId: string, q = '', limit = 20) {
    const profile = await this.loadImported(profileId);
    const query = String(q ?? '').trim();
    const rows = await this.prisma.user.findMany({
      where: {
        isSystemAccount: false,
        provider: { not: IMPORTED_PROVIDER },
        ...(query
          ? {
              OR: [
                { username: { contains: query, mode: 'insensitive' as const } },
                { gameNickname: { contains: query, mode: 'insensitive' as const } },
                { email: { contains: query, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: PROFILE_SELECT,
      orderBy: { username: 'asc' },
      take: query ? Math.min(Math.max(1, limit), 50) : 200,
    });
    const scores = new Map(
      suggestTargets(profile, rows, rows.length, 0).map((s) => [s.id, s]),
    );
    const items = rows.map((r) => ({
      ...this.publicProfile(r),
      score: scores.get(r.id)?.score ?? 0,
      matchedOn: scores.get(r.id)?.matchedOn ?? null,
    }));
    // Without a query the list is the suggestion list: best matches first.
    if (!query) {
      return items
        .filter((i) => i.score > 0)
        .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username))
        .slice(0, Math.min(Math.max(1, limit), 50));
    }
    return items.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
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

    const registryRow = await this.prisma.appSetting.findUnique({
      where: { key: LEGACY_REGISTRY_KEY },
    });
    const registry = retargetRegistryPlayers(registryRow?.value, source.id, target.id);

    const reasons: string[] = [];
    if (conflicts.length) {
      reasons.push(
        `Le compte cible possède déjà une feuille de match sur ${conflicts.length} match(s) du profil importé.`,
      );
    }
    if (duplicatedGames.length) {
      reasons.push(
        `${duplicatedGames.length} manche(s) listent déjà les deux profils : la fusion créerait un doublon.`,
      );
    }
    for (const b of blocking) {
      reasons.push(
        `Le profil importé possède ${b.count} ${b.label} : à traiter à la main avant la fusion.`,
      );
    }

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
   * placeholder and repoint the import registry.
   *
   * The reads and the plan happen first, then a single `$transaction` applies
   * every write (MongoDB replica set): either the whole history moves, or
   * nothing does. The counters of the target are recomputed afterwards with
   * the shared helper, outside of the transaction, because it is derived data
   * that any later match edit recomputes anyway.
   *
   * Idempotent: every write is a `updateMany` / `deleteMany` filtered on the
   * source id, so replaying a half-applied merge converges to the same state.
   */
  async merge(profileId: string, targetId: string, actor: Actor) {
    const plan = await this.preview(profileId, targetId);
    if (!plan.canMerge) throw new ConflictException(plan.reasons.join(' '));

    const source = plan.source;
    const target = plan.target;
    const p = this.prisma;

    const matches = await this.matchesReferencing(source.id);
    const gameWrites = matches
      .map((m) => ({ id: m.id, ...retargetGames(m.games, source.id, target.id) }))
      .filter((m) => m.changed > 0);

    const registryRow = await p.appSetting.findUnique({ where: { key: LEGACY_REGISTRY_KEY } });
    const registry = retargetRegistryPlayers(registryRow?.value, source.id, target.id);

    const ops: any[] = [
      // Team memberships: the rows the target already has win.
      ...plan.moves.droppedTeamMemberships.map((m) =>
        p.esportTeamMember.delete({ where: { id: m.id } }),
      ),
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
      // Residue of the placeholder: never moved, it describes nothing.
      ...DROPPED_COLLECTIONS.map((c) =>
        (p as any)[c.model].deleteMany({ where: { [c.field]: source.id } }),
      ),
      p.friendship.deleteMany({
        where: { OR: [{ requesterId: source.id }, { addresseeId: source.id }] },
      }),
    ];
    if (registry.value) {
      ops.push(
        p.appSetting.update({
          where: { key: LEGACY_REGISTRY_KEY },
          data: { value: registry.value },
        }),
      );
    }
    ops.push(p.user.delete({ where: { id: source.id } }));

    await p.$transaction(ops);

    await this.playerStats.recomputeUsers([target.id]);

    await this.log(
      'imported.merge',
      actor,
      target.id,
      `Profil importé « ${source.username} » (${source.id}) fusionné dans « ${target.username} » : ` +
        `${plan.moves.teamMemberships.length} appartenance(s), ${plan.moves.matchPlayers} feuille(s) de match, ` +
        `${plan.moves.awards.length} distinction(s), ${plan.moves.gamePicks} pick(s), ` +
        `${registry.legacyIds.length} entrée(s) de registre.`,
    );

    const merged = await this.prisma.user.findUnique({
      where: { id: target.id },
      select: PROFILE_SELECT,
    });
    return {
      success: true,
      source,
      target: merged ? this.publicProfile(merged) : target,
      moved: plan.moves,
      dropped: plan.drops,
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
    const taken = await this.prisma.user.findUnique({ where: { email: next } });
    if (taken && taken.id !== profile.id) {
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
    const user = await this.prisma.user.findUnique({ where: { id }, select: PROFILE_SELECT });
    if (!user) throw new NotFoundException('Profil introuvable.');
    if (!isImportedProfile(user)) {
      throw new BadRequestException('Ce compte n’est pas un profil importé.');
    }
    return user as any;
  }

  private async loadPair(profileId: string, targetId: string) {
    if (!targetId) throw new BadRequestException('Compte cible manquant.');
    if (profileId === targetId) {
      throw new BadRequestException('Le profil importé et le compte cible sont le même compte.');
    }
    const source = await this.loadImported(profileId);
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: PROFILE_SELECT,
    });
    if (!target) throw new NotFoundException('Compte cible introuvable.');
    if (target.isSystemAccount) {
      throw new BadRequestException('Un compte technique ne peut pas recevoir un profil importé.');
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
    const out: { model: string; label: string; count: number }[] = [];
    for (const c of BLOCKING_COLLECTIONS) {
      const count = await (this.prisma as any)[c.model].count({ where: { [c.field]: userId } });
      if (count > 0) out.push({ model: c.model, label: c.label, count });
    }
    return out;
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
