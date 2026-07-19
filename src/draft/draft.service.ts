import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from '../community/community.service';
import { parseJson, toJson } from '../common/utils/json.util';

// The 5 MLBB lanes used to compose a 5v5 team.
const LANES_5V5 = ['gold', 'mid', 'jungle', 'exp', 'roam'];
const CATEGORY_SIZE: Record<string, number> = { '1v1': 1, '3v3': 3, '5v5': 5 };

// DiceBear "icons" collection (object glyphs, not human avatars) to give each
// randomly-drafted team a distinct icon. Swappable later if a weapon-specific
// set is preferred.
function diceBearIcon(seed: string): string {
  return `https://api.dicebear.com/9.x/icons/svg?seed=${encodeURIComponent(seed)}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

@Injectable()
export class DraftService {
  constructor(
    private prisma: PrismaService,
    private community: CommunityService,
  ) {}

  /* ---------------- Helpers ---------------- */

  private serializeTournament(t: any, extra: Record<string, any> = {}) {
    return {
      id: t.id,
      name: t.name,
      description: t.description || '',
      category: t.category,
      teamSize: t.teamSize,
      roles: parseJson<string[]>(t.roles, []),
      status: t.status,
      registrationOpensAt: t.registrationOpensAt,
      registrationClosesAt: t.registrationClosesAt,
      secondPhaseOpen: t.secondPhaseOpen,
      secondPhaseClosesAt: t.secondPhaseClosesAt,
      createdAt: t.createdAt,
      ...extra,
    };
  }

  private async getTournamentOrThrow(id: string) {
    const t = await this.prisma.draftTournament.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tournoi introuvable.');
    return t;
  }

  private requiredRoles(t: any): string[] {
    if (t.category === '5v5') return LANES_5V5;
    const roles = parseJson<string[]>(t.roles, []);
    return roles;
  }

  /* ---------------- Public / player ---------------- */

  // Tournaments visible to players: open for registration or already running.
  async listForPlayers(userId?: string) {
    const tournaments = await this.prisma.draftTournament.findMany({
      where: { status: { in: ['registration', 'closed', 'drafted', 'ongoing', 'completed'] } },
      orderBy: { createdAt: 'desc' },
    });
    const myRegs = userId
      ? await this.prisma.draftRegistration.findMany({ where: { userId } })
      : [];
    const regByTournament = new Set(myRegs.map((r) => r.tournamentId));
    const counts = await this.prisma.draftRegistration.groupBy({
      by: ['tournamentId'],
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.tournamentId, c._count._all]));
    return tournaments.map((t) =>
      this.serializeTournament(t, {
        registeredCount: countMap.get(t.id) ?? 0,
        registered: regByTournament.has(t.id),
      }),
    );
  }

  async getForPlayer(id: string, userId?: string) {
    const t = await this.getTournamentOrThrow(id);
    const registeredCount = await this.prisma.draftRegistration.count({
      where: { tournamentId: id },
    });
    const myReg = userId
      ? await this.prisma.draftRegistration.findFirst({
          where: { tournamentId: id, userId },
        })
      : null;
    return this.serializeTournament(t, {
      registeredCount,
      registered: !!myReg,
      myPreferredRole: myReg?.preferredRole ?? null,
    });
  }

  async register(tournamentId: string, userId: string, preferredRole: string) {
    const t = await this.getTournamentOrThrow(tournamentId);
    const secondPhase = t.status === 'drafted' && t.secondPhaseOpen;
    if (t.status !== 'registration' && !secondPhase) {
      throw new BadRequestException('Les inscriptions ne sont pas ouvertes.');
    }
    if (
      t.registrationClosesAt &&
      t.status === 'registration' &&
      new Date() > t.registrationClosesAt
    ) {
      throw new BadRequestException('La période d’inscription est terminée.');
    }
    const existing = await this.prisma.draftRegistration.findFirst({
      where: { tournamentId, userId },
    });
    if (existing) {
      return this.prisma.draftRegistration.update({
        where: { id: existing.id },
        data: { preferredRole },
      });
    }
    return this.prisma.draftRegistration.create({
      data: {
        tournamentId,
        userId,
        preferredRole,
        phase: secondPhase ? 2 : 1,
      },
    });
  }

  async unregister(tournamentId: string, userId: string) {
    const t = await this.getTournamentOrThrow(tournamentId);
    if (t.status !== 'registration') {
      throw new BadRequestException('Impossible de se désinscrire à ce stade.');
    }
    await this.prisma.draftRegistration.deleteMany({
      where: { tournamentId, userId },
    });
    return { ok: true };
  }

  // Teams + bracket for display.
  async getBracket(tournamentId: string) {
    await this.getTournamentOrThrow(tournamentId);
    const [teams, matches] = await Promise.all([
      this.prisma.draftTeam.findMany({ where: { tournamentId } }),
      this.prisma.draftMatch.findMany({
        where: { tournamentId },
        orderBy: [{ round: 'asc' }, { position: 'asc' }],
      }),
    ]);
    return { teams, matches };
  }

  async getMyTeam(tournamentId: string, userId: string) {
    const member = await this.prisma.draftTeamMember.findFirst({
      where: { tournamentId, userId },
    });
    if (!member) return null;
    const team = await this.prisma.draftTeam.findUnique({
      where: { id: member.teamId },
    });
    const teammates = await this.prisma.draftTeamMember.findMany({
      where: { teamId: member.teamId },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: teammates.map((m) => m.userId) } },
      select: { id: true, username: true, gameNickname: true, avatar: true, gameAvatar: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return {
      team,
      assignedRole: member.assignedRole,
      members: teammates.map((m) => ({
        userId: m.userId,
        name: userMap.get(m.userId)?.gameNickname || userMap.get(m.userId)?.username || 'Joueur',
        assignedRole: m.assignedRole,
        preferredRole: m.preferredRole,
      })),
    };
  }

  /* ---------------- Admin ---------------- */

  async adminList() {
    const tournaments = await this.prisma.draftTournament.findMany({
      orderBy: { createdAt: 'desc' },
    });
    const counts = await this.prisma.draftRegistration.groupBy({
      by: ['tournamentId'],
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.tournamentId, c._count._all]));
    return tournaments.map((t) =>
      this.serializeTournament(t, { registeredCount: countMap.get(t.id) ?? 0 }),
    );
  }

  async create(dto: any, adminId?: string) {
    const teamSize = CATEGORY_SIZE[dto.category];
    if (!teamSize) throw new BadRequestException('Catégorie invalide (1v1, 3v3, 5v5).');
    let roles: string[] = [];
    if (dto.category === '5v5') roles = LANES_5V5;
    else roles = Array.isArray(dto.roles) ? dto.roles.slice(0, teamSize) : [];
    const created = await this.prisma.draftTournament.create({
      data: {
        name: (dto.name || '').trim(),
        description: (dto.description || '').trim() || null,
        category: dto.category,
        teamSize,
        roles: toJson(roles),
        createdById: adminId,
      },
    });
    return this.serializeTournament(created);
  }

  async update(id: string, dto: any) {
    const t = await this.getTournamentOrThrow(id);
    const data: any = {};
    if (dto.name !== undefined) data.name = String(dto.name).trim();
    if (dto.description !== undefined) data.description = String(dto.description).trim() || null;
    if (dto.roles !== undefined && t.category !== '5v5') {
      data.roles = toJson(Array.isArray(dto.roles) ? dto.roles.slice(0, t.teamSize) : []);
    }
    if (dto.registrationOpensAt !== undefined)
      data.registrationOpensAt = dto.registrationOpensAt ? new Date(dto.registrationOpensAt) : null;
    if (dto.registrationClosesAt !== undefined)
      data.registrationClosesAt = dto.registrationClosesAt ? new Date(dto.registrationClosesAt) : null;
    const updated = await this.prisma.draftTournament.update({ where: { id }, data });
    return this.serializeTournament(updated);
  }

  async remove(id: string) {
    await this.getTournamentOrThrow(id);
    await this.prisma.$transaction([
      this.prisma.draftMatch.deleteMany({ where: { tournamentId: id } }),
      this.prisma.draftTeamMember.deleteMany({ where: { tournamentId: id } }),
      this.prisma.draftTeam.deleteMany({ where: { tournamentId: id } }),
      this.prisma.draftRegistration.deleteMany({ where: { tournamentId: id } }),
      this.prisma.draftTournament.delete({ where: { id } }),
    ]);
    return { ok: true };
  }

  async openRegistration(id: string) {
    const t = await this.getTournamentOrThrow(id);
    const updated = await this.prisma.draftTournament.update({
      where: { id },
      data: { status: 'registration' },
    });
    // Notify every (non-banned) user that a tournament just opened.
    const users = await this.prisma.user.findMany({
      where: { isBanned: false },
      select: { id: true },
    });
    await Promise.all(
      users.map((u) =>
        this.community.notifyUser(u.id, {
          type: 'tournament_open',
          title: 'Nouveau tournoi ouvert',
          message: `Inscriptions ouvertes pour « ${t.name} » (${t.category}).`,
          link: `/draft/${id}`,
          data: { tournamentId: id, name: t.name, category: t.category },
        }),
      ),
    );
    return this.serializeTournament(updated);
  }

  async closeRegistration(id: string) {
    await this.getTournamentOrThrow(id);
    const updated = await this.prisma.draftTournament.update({
      where: { id },
      data: { status: 'closed' },
    });
    return this.serializeTournament(updated);
  }

  async getRegistrations(id: string) {
    const regs = await this.prisma.draftRegistration.findMany({
      where: { tournamentId: id },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: regs.map((r) => r.userId) } },
      select: { id: true, username: true, gameNickname: true, avatar: true, gameAvatar: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return regs.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: userMap.get(r.userId)?.gameNickname || userMap.get(r.userId)?.username || 'Joueur',
      preferredRole: r.preferredRole,
      phase: r.phase,
    }));
  }

  // The heart of the feature: compose random teams honoring roles, then build
  // the bracket. Registration must be closed (or drafted, to re-run).
  async runDraft(id: string) {
    const t = await this.getTournamentOrThrow(id);
    if (!['closed', 'drafted'].includes(t.status)) {
      throw new BadRequestException(
        'Fermez d’abord les inscriptions avant de lancer le draft.',
      );
    }
    const roles = this.requiredRoles(t);
    if (roles.length !== t.teamSize) {
      throw new BadRequestException(
        'Les rôles du tournoi doivent correspondre à la taille d’équipe.',
      );
    }

    const regs = await this.prisma.draftRegistration.findMany({
      where: { tournamentId: id },
    });
    if (regs.length < t.teamSize) {
      throw new BadRequestException('Pas assez d’inscrits pour former une équipe.');
    }

    // Reset any previous draft for this tournament.
    await this.prisma.$transaction([
      this.prisma.draftMatch.deleteMany({ where: { tournamentId: id } }),
      this.prisma.draftTeamMember.deleteMany({ where: { tournamentId: id } }),
      this.prisma.draftTeam.deleteMany({ where: { tournamentId: id } }),
    ]);

    const players = shuffle(regs);
    const numTeams = Math.floor(players.length / t.teamSize);
    const used = players.slice(0, numTeams * t.teamSize);
    const leftover = players.slice(numTeams * t.teamSize);

    // Slots: numTeams teams, each with the required roles (role -> playerReg).
    const teamsSlots: Array<Record<string, any | null>> = Array.from(
      { length: numTeams },
      () => Object.fromEntries(roles.map((r) => [r, null])),
    );

    const assignedIds = new Set<string>();
    // Pass 1: honor preferred roles where a slot is free.
    for (const p of used) {
      const team = teamsSlots.find((s) => s[p.preferredRole] === null && roles.includes(p.preferredRole));
      if (team) {
        team[p.preferredRole] = p;
        assignedIds.add(p.id);
      }
    }
    // Pass 2: fill remaining players into any free slot (reassigned role).
    for (const p of used) {
      if (assignedIds.has(p.id)) continue;
      for (const team of teamsSlots) {
        const openRole = roles.find((r) => team[r] === null);
        if (openRole) {
          team[openRole] = p;
          assignedIds.add(p.id);
          break;
        }
      }
    }

    // Persist complete teams + members.
    const createdTeams: any[] = [];
    for (let i = 0; i < numTeams; i++) {
      const seed = `${id}-${i}`;
      const team = await this.prisma.draftTeam.create({
        data: {
          tournamentId: id,
          name: `Équipe ${i + 1}`,
          icon: diceBearIcon(seed),
          seed: i,
          complete: true,
        },
      });
      createdTeams.push(team);
      for (const role of roles) {
        const p = teamsSlots[i][role];
        if (!p) continue;
        await this.prisma.draftTeamMember.create({
          data: {
            tournamentId: id,
            teamId: team.id,
            userId: p.userId,
            preferredRole: p.preferredRole,
            assignedRole: role,
          },
        });
      }
    }

    // Incomplete team (leftover players) — kept out of the bracket by default;
    // the admin can eliminate it or open a second registration phase to fill it.
    if (leftover.length > 0) {
      const seed = `${id}-incomplete`;
      const team = await this.prisma.draftTeam.create({
        data: {
          tournamentId: id,
          name: 'Équipe incomplète',
          icon: diceBearIcon(seed),
          seed: numTeams,
          complete: false,
          eliminated: true,
        },
      });
      for (const p of leftover) {
        await this.prisma.draftTeamMember.create({
          data: {
            tournamentId: id,
            teamId: team.id,
            userId: p.userId,
            preferredRole: p.preferredRole,
            assignedRole: p.preferredRole,
          },
        });
      }
    }

    await this.buildBracket(id, createdTeams);

    await this.prisma.draftTournament.update({
      where: { id },
      data: { status: 'drafted' },
    });
    return this.getBracket(id);
  }

  // Single-elimination bracket over the complete teams.
  private async buildBracket(tournamentId: string, teams: any[]) {
    const seeds = shuffle(teams);
    const n = seeds.length;
    if (n < 2) return;
    let size = 1;
    while (size < n) size *= 2; // next power of two
    // Round 1 slots (byes = null opponent).
    const slots: Array<any | null> = [];
    for (let i = 0; i < size; i++) slots.push(seeds[i] ?? null);

    const totalRounds = Math.log2(size);
    // Round 1 matches
    const round1: any[] = [];
    for (let p = 0; p < size / 2; p++) {
      const teamA = slots[p * 2];
      const teamB = slots[p * 2 + 1];
      const m = await this.prisma.draftMatch.create({
        data: {
          tournamentId,
          round: 1,
          position: p,
          teamAId: teamA?.id ?? null,
          teamBId: teamB?.id ?? null,
          // A bye (missing opponent) auto-advances the present team.
          winnerTeamId: teamA && !teamB ? teamA.id : teamB && !teamA ? teamB.id : null,
          status: (teamA && !teamB) || (teamB && !teamA) ? 'done' : 'pending',
        },
      });
      round1.push(m);
    }
    // Empty placeholder matches for later rounds.
    for (let r = 2; r <= totalRounds; r++) {
      const matchesInRound = size / Math.pow(2, r);
      for (let p = 0; p < matchesInRound; p++) {
        await this.prisma.draftMatch.create({
          data: { tournamentId, round: r, position: p, status: 'pending' },
        });
      }
    }
    // Propagate any byes into round 2.
    for (const m of round1) {
      if (m.winnerTeamId) await this.advanceWinner(tournamentId, m, m.winnerTeamId);
    }
  }

  async setMatchWinner(tournamentId: string, matchId: string, winnerTeamId: string) {
    const match = await this.prisma.draftMatch.findUnique({ where: { id: matchId } });
    if (!match || match.tournamentId !== tournamentId) {
      throw new NotFoundException('Match introuvable.');
    }
    if (![match.teamAId, match.teamBId].includes(winnerTeamId)) {
      throw new BadRequestException('Ce vainqueur ne joue pas ce match.');
    }
    const updated = await this.prisma.draftMatch.update({
      where: { id: matchId },
      data: { winnerTeamId, status: 'done' },
    });
    await this.advanceWinner(tournamentId, updated, winnerTeamId);
    return this.getBracket(tournamentId);
  }

  // Place a winner into the next round's match slot.
  private async advanceWinner(tournamentId: string, match: any, winnerTeamId: string) {
    const nextRound = match.round + 1;
    const nextPos = Math.floor(match.position / 2);
    const next = await this.prisma.draftMatch.findFirst({
      where: { tournamentId, round: nextRound, position: nextPos },
    });
    if (!next) return; // final
    const slot = match.position % 2 === 0 ? 'teamAId' : 'teamBId';
    await this.prisma.draftMatch.update({
      where: { id: next.id },
      data: { [slot]: winnerTeamId },
    });
  }

  async eliminateTeam(tournamentId: string, teamId: string) {
    await this.prisma.draftTeam.update({
      where: { id: teamId },
      data: { eliminated: true },
    });
    return { ok: true };
  }

  // Open a second, time-boxed registration phase to complete an incomplete team.
  async openSecondPhase(id: string, closesAt?: string) {
    const t = await this.getTournamentOrThrow(id);
    if (t.status !== 'drafted') {
      throw new BadRequestException('Le draft doit avoir été lancé.');
    }
    const updated = await this.prisma.draftTournament.update({
      where: { id },
      data: {
        secondPhaseOpen: true,
        secondPhaseClosesAt: closesAt ? new Date(closesAt) : null,
      },
    });
    const users = await this.prisma.user.findMany({
      where: { isBanned: false },
      select: { id: true },
    });
    await Promise.all(
      users.map((u) =>
        this.community.notifyUser(u.id, {
          type: 'tournament_second_phase',
          title: 'Places restantes dans un tournoi',
          message: `Il manque des joueurs pour « ${t.name} ». Inscris-toi vite !`,
          link: `/draft/${id}`,
          data: { tournamentId: id, name: t.name },
        }),
      ),
    );
    return this.serializeTournament(updated);
  }

  // Finalize: mark ongoing and notify each drafted player of their team.
  async publish(id: string) {
    const t = await this.getTournamentOrThrow(id);
    const updated = await this.prisma.draftTournament.update({
      where: { id },
      data: { status: 'ongoing', secondPhaseOpen: false },
    });
    const members = await this.prisma.draftTeamMember.findMany({
      where: { tournamentId: id },
    });
    const teams = await this.prisma.draftTeam.findMany({ where: { tournamentId: id } });
    const teamMap = new Map(teams.map((tm) => [tm.id, tm]));
    await Promise.all(
      members
        .filter((m) => !teamMap.get(m.teamId)?.eliminated)
        .map((m) =>
          this.community.notifyUser(m.userId, {
            type: 'tournament_team',
            title: 'Ton équipe est prête',
            message: `Tu es dans « ${teamMap.get(m.teamId)?.name} » (${m.assignedRole}) pour « ${t.name} ».`,
            link: `/draft/${id}`,
            data: { tournamentId: id, teamId: m.teamId, role: m.assignedRole },
          }),
        ),
    );
    return this.serializeTournament(updated);
  }
}
