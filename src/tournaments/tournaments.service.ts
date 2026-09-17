import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GamificationService } from '../gamification/gamification.service';
import { hydrate, parseJson, toJson } from '../common/utils/json.util';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { UpdateTournamentDto } from './dto/update-tournament.dto';
import {
  GenerateBracketDto,
  MatchResultDto,
  MatchStatusDto,
  ScheduleMatchDto,
  SetMvpDto,
} from './dto/bracket.dto';
import {
  BracketMatch,
  applyResult,
  findMatch,
  generateBracket,
  groupRounds,
  isFinal,
  totalRounds,
} from './bracket.util';

const JSON_KEYS = ['registeredTeams', 'brackets'] as const;

const MVP_SELECT = {
  id: true,
  username: true,
  avatar: true,
  gameNickname: true,
  gameAvatar: true,
  rank: true,
  role: true,
} as const;

const RESULT_ERRORS: Record<string, string> = {
  MATCH_NOT_FOUND: 'Match introuvable.',
  MATCH_INCOMPLETE: 'Les deux équipes ne sont pas encore connues.',
  WINNER_REQUIRED: 'Égalité : précisez le vainqueur.',
  WINNER_NOT_IN_MATCH: 'Ce vainqueur ne joue pas ce match.',
};

function serialize(tournament: any) {
  if (!tournament) return tournament;
  return hydrate(tournament, [...JSON_KEYS]);
}

@Injectable()
export class TournamentsService {
  constructor(
    private prisma: PrismaService,
    @Optional() private gamification?: GamificationService,
  ) {}

  async findAll() {
    const tournaments = await this.prisma.tournament.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return tournaments.map(serialize);
  }

  async findOne(id: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (!tournament) throw new NotFoundException('Tournoi introuvable.');
    return serialize(tournament);
  }

  async create(dto: CreateTournamentDto) {
    const tournament = await this.prisma.tournament.create({
      data: {
        name: dto.name,
        description: dto.description,
        organizer: dto.organizer,
        status: dto.status ?? 'upcoming',
        startDate: dto.startDate,
        endDate: dto.endDate,
        prizePool: dto.prizePool,
        ...(dto.maxTeams !== undefined ? { maxTeams: dto.maxTeams } : {}),
        registeredTeams: toJson(dto.registeredTeams ?? []),
        brackets: toJson(dto.brackets ?? []),
        format: dto.format,
        rules: dto.rules,
        banner: dto.banner,
        streamUrl: dto.streamUrl,
      },
    });
    return serialize(tournament);
  }

  async update(id: string, dto: UpdateTournamentDto) {
    await this.findOne(id);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.organizer !== undefined) data.organizer = dto.organizer;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.startDate !== undefined) data.startDate = dto.startDate;
    if (dto.endDate !== undefined) data.endDate = dto.endDate;
    if (dto.prizePool !== undefined) data.prizePool = dto.prizePool;
    if (dto.maxTeams !== undefined) data.maxTeams = dto.maxTeams;
    if (dto.registeredTeams !== undefined)
      data.registeredTeams = toJson(dto.registeredTeams);
    if (dto.brackets !== undefined) data.brackets = toJson(dto.brackets);
    if (dto.format !== undefined) data.format = dto.format;
    if (dto.rules !== undefined) data.rules = dto.rules;
    if (dto.banner !== undefined) data.banner = dto.banner;
    if (dto.streamUrl !== undefined) data.streamUrl = dto.streamUrl;

    const tournament = await this.prisma.tournament.update({
      where: { id },
      data,
    });
    return serialize(tournament);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.tournament.delete({ where: { id } });
    return { success: true };
  }

  /** Register an esport team into a tournament (idempotent per team). */
  async register(id: string, teamId: string) {
    if (!teamId) throw new BadRequestException('Équipe requise.');
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException('Tournoi introuvable.');
    const team = await this.prisma.esportTeam.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Équipe introuvable.');

    const teams: any[] = parseJson(tournament.registeredTeams, []);
    if (teams.some((t) => t.id === teamId))
      throw new BadRequestException('Équipe déjà inscrite.');
    if (teams.length >= tournament.maxTeams)
      throw new BadRequestException('Tournoi complet.');
    teams.push({ id: team.id, name: team.name, logo: team.image ?? null });

    const updated = await this.prisma.tournament.update({
      where: { id },
      data: { registeredTeams: toJson(teams) },
    });
    void this.rewardRegistration(id, teamId);
    return serialize(updated);
  }

  /** XP for every member of the registered team (never throws). */
  private async rewardRegistration(tournamentId: string, teamId: string) {
    if (!this.gamification) return;
    try {
      const members = await this.prisma.esportTeamMember.findMany({
        where: { teamId },
        select: { userId: true },
      });
      for (const m of members)
        await this.gamification.trackSafe(m.userId, 'tournament_registration', tournamentId);
    } catch {
      /* ignore */
    }
  }

  async unregister(id: string, teamId: string) {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException('Tournoi introuvable.');
    const teams: any[] = parseJson(tournament.registeredTeams, []).filter(
      (t: any) => t.id !== teamId,
    );
    const updated = await this.prisma.tournament.update({
      where: { id },
      data: { registeredTeams: toJson(teams) },
    });
    return serialize(updated);
  }
  /* ---------------- Bracket / details ---------------- */

  private matchesOf(tournament: any): BracketMatch[] {
    const raw = parseJson<any>(tournament.brackets, []);
    return Array.isArray(raw) ? (raw as BracketMatch[]) : [];
  }

  private async saveMatches(id: string, matches: BracketMatch[], extra: any = {}) {
    const tournament = await this.prisma.tournament.update({
      where: { id },
      data: { brackets: toJson(matches), ...extra },
    });
    return serialize(tournament);
  }

  /** Full detail view: participants, structured bracket, results, MVP, schedule, live match. */
  async getDetails(id: string) {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException('Tournoi introuvable.');

    const registered: any[] = parseJson(tournament.registeredTeams, []);
    const teamIds = registered.map((r) => r.id).filter(Boolean);
    const [teams, mvpUser] = await Promise.all([
      teamIds.length
        ? this.prisma.esportTeam.findMany({
            where: { id: { in: teamIds } },
            include: {
              members: {
                orderBy: { sort: 'asc' },
                include: {
                  user: {
                    select: { id: true, username: true, avatar: true, gameNickname: true, gameAvatar: true },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      tournament.mvpUserId
        ? this.prisma.user.findUnique({ where: { id: tournament.mvpUserId }, select: MVP_SELECT })
        : Promise.resolve(null),
    ]);
    const teamMap = new Map(teams.map((t) => [t.id, t]));

    const matches = this.matchesOf(tournament);
    const wins = new Map<string, number>();
    for (const m of matches) {
      if (m.status === 'finished' && m.winnerTeamId) {
        wins.set(m.winnerTeamId, (wins.get(m.winnerTeamId) ?? 0) + 1);
      }
    }
    const total = totalRounds(matches);
    const finalMatch = matches.find((m) => m.round === total);
    const championId = finalMatch?.status === 'finished' ? finalMatch.winnerTeamId : null;
    const eliminated = new Set<string>();
    for (const m of matches) {
      if (m.status === 'finished' && m.winnerTeamId) {
        const loser = m.winnerTeamId === m.teamAId ? m.teamBId : m.teamAId;
        if (loser) eliminated.add(loser);
      }
    }

    const participants = registered.map((r, index) => {
      const team = teamMap.get(r.id);
      const captain = team?.members.find((m) => m.isCaptain)?.user ?? null;
      return {
        id: r.id,
        name: team?.name ?? r.name,
        logo: team?.image ?? r.logo ?? null,
        seed: index + 1,
        exists: !!team,
        type: team?.type ?? null,
        membersCount: team?.members.length ?? 0,
        captain: captain
          ? { id: captain.id, name: captain.gameNickname || captain.username, avatar: captain.gameAvatar || captain.avatar }
          : null,
        wins: wins.get(r.id) ?? 0,
        eliminated: eliminated.has(r.id),
        champion: championId === r.id,
      };
    });
    const participantMap = new Map(participants.map((p) => [p.id, p]));
    const teamRef = (teamId: string | null) => {
      if (!teamId) return null;
      const p = participantMap.get(teamId);
      return p ? { id: p.id, name: p.name, logo: p.logo, seed: p.seed } : { id: teamId, name: '?', logo: null, seed: null };
    };
    const enrich = (m: BracketMatch) => ({ ...m, teamA: teamRef(m.teamAId), teamB: teamRef(m.teamBId) });

    const rounds = groupRounds(matches).map((r) => ({ ...r, matches: r.matches.map(enrich) }));
    const results = rounds
      .map((r) => ({
        round: r.round,
        key: r.key,
        matches: r.matches.filter((m) => m.status === 'finished'),
      }))
      .filter((r) => r.matches.length > 0);
    const schedule = matches
      .filter((m) => m.scheduledAt && m.status !== 'bye')
      .map(enrich)
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    const live = matches.find((m) => m.status === 'live');

    return {
      tournament: serialize(tournament),
      participants,
      bracket: { format: 'single_elimination', totalRounds: total, rounds },
      results,
      champion: championId ? teamRef(championId) : null,
      mvp: mvpUser
        ? {
            userId: mvpUser.id,
            name: mvpUser.gameNickname || mvpUser.username,
            avatar: mvpUser.gameAvatar || mvpUser.avatar,
            rank: mvpUser.rank,
            role: mvpUser.role,
          }
        : null,
      schedule,
      liveMatch: live ? enrich(live) : null,
    };
  }

  /** Admin: (re)generate the bracket from the registered teams. */
  async generateBracket(id: string, dto: GenerateBracketDto) {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException('Tournoi introuvable.');
    const teams: any[] = parseJson(tournament.registeredTeams, []);
    if (teams.length < 2)
      throw new BadRequestException('Au moins deux équipes inscrites sont nécessaires.');
    const matches = generateBracket(teams, dto.seeding ?? 'random');
    const extra = tournament.status === 'upcoming' ? { status: 'ongoing' } : {};
    return this.saveMatches(id, matches, extra);
  }

  /** Admin: clear the bracket. */
  async resetBracket(id: string) {
    await this.findOne(id);
    return this.saveMatches(id, []);
  }

  private async loadMatch(id: string, matchId: string) {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException('Tournoi introuvable.');
    const matches = this.matchesOf(tournament);
    const match = findMatch(matches, matchId);
    if (!match) throw new NotFoundException('Match introuvable.');
    return { tournament, matches, match };
  }

  /** Admin: set a result; the winner advances to the next round. */
  async setMatchResult(id: string, matchId: string, dto: MatchResultDto) {
    const { matches } = await this.loadMatch(id, matchId);
    const res = applyResult(matches, matchId, dto.scoreA, dto.scoreB, dto.winnerTeamId);
    if (res.error) throw new BadRequestException(RESULT_ERRORS[res.error] ?? res.error);
    const updated = findMatch(res.matches, matchId)!;
    const extra = isFinal(res.matches, updated) ? { status: 'completed' } : {};
    return this.saveMatches(id, res.matches, extra);
  }

  /** Admin: schedule a match (date and/or stream URL). */
  async scheduleMatch(id: string, matchId: string, dto: ScheduleMatchDto) {
    const { matches, match } = await this.loadMatch(id, matchId);
    if (dto.scheduledAt !== undefined) {
      if (dto.scheduledAt && Number.isNaN(Date.parse(dto.scheduledAt)))
        throw new BadRequestException('Date invalide.');
      match.scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt).toISOString() : null;
    }
    if (dto.streamUrl !== undefined) match.streamUrl = dto.streamUrl || null;
    if (match.status === 'pending' && match.scheduledAt) match.status = 'scheduled';
    if (match.status === 'scheduled' && !match.scheduledAt) match.status = 'pending';
    return this.saveMatches(id, matches);
  }

  /** Admin: mark a match live / finished / scheduled / pending. */
  async setMatchStatus(id: string, matchId: string, dto: MatchStatusDto) {
    const { matches, match } = await this.loadMatch(id, matchId);
    if (match.status === 'bye') throw new BadRequestException('Un bye ne peut pas changer de statut.');
    if (dto.status === 'live' && (!match.teamAId || !match.teamBId))
      throw new BadRequestException('Les deux équipes ne sont pas encore connues.');
    if (dto.status === 'finished' && !match.winnerTeamId)
      throw new BadRequestException('Saisissez d’abord le résultat.');
    if (dto.status === 'live') {
      // Only one live match at a time.
      for (const m of matches) {
        if (m.id !== match.id && m.status === 'live') m.status = m.scheduledAt ? 'scheduled' : 'pending';
      }
    }
    match.status = dto.status;
    return this.saveMatches(id, matches);
  }

  /** Admin: set (or clear) the tournament MVP. */
  async setMvp(id: string, dto: SetMvpDto) {
    await this.findOne(id);
    if (dto.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true } });
      if (!user) throw new NotFoundException('Joueur introuvable.');
    }
    const tournament = await this.prisma.tournament.update({
      where: { id },
      data: { mvpUserId: dto.userId || null },
    });
    return serialize(tournament);
  }
}
