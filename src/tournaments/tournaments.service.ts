import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hydrate, parseJson, toJson } from '../common/utils/json.util';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { UpdateTournamentDto } from './dto/update-tournament.dto';

const JSON_KEYS = ['registeredTeams', 'brackets'] as const;

function serialize(tournament: any) {
  if (!tournament) return tournament;
  return hydrate(tournament, [...JSON_KEYS]);
}

@Injectable()
export class TournamentsService {
  constructor(private prisma: PrismaService) {}

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
    return serialize(updated);
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
}
