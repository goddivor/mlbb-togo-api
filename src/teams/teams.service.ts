import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { computeWinRate } from '../users/users.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';

const STAFF_ROLES = ['admin', 'moderator'];

@Injectable()
export class TeamsService {
  constructor(private prisma: PrismaService) {}

  private async serialize(team: any) {
    const members = await this.prisma.user.findMany({
      where: { teamId: team.id },
      select: { id: true },
    });
    const memberIds = members.map((m) => m.id);
    if (team.captainId && !memberIds.includes(team.captainId)) {
      memberIds.push(team.captainId);
    }
    return {
      ...team,
      achievements: parseJson<string[]>(team.achievements, []),
      lookingFor: parseJson<string[]>(team.lookingFor, []),
      winRate: computeWinRate(team.wins, team.losses),
      members: memberIds,
    };
  }

  async findAll() {
    const teams = await this.prisma.team.findMany();
    return Promise.all(teams.map((t) => this.serialize(t)));
  }

  async findOne(id: string) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    return this.serialize(team);
  }

  async create(dto: CreateTeamDto, captainId?: string) {
    const team = await this.prisma.team.create({
      data: {
        name: dto.name,
        tag: dto.tag,
        description: dto.description ?? undefined,
        logo: dto.logo ?? undefined,
        maxMembers: dto.maxMembers ?? undefined,
        region: dto.region ?? undefined,
        isRecruiting: dto.isRecruiting ?? undefined,
        lookingFor: toJson(dto.lookingFor ?? []),
        achievements: toJson(dto.achievements ?? []),
        captainId: captainId ?? undefined,
      },
    });
    return this.serialize(team);
  }

  /** Only the team captain (or staff) may modify or delete a team. */
  private async assertCanManage(
    id: string,
    user?: { id?: string; roleUser?: string },
  ) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) throw new NotFoundException('Équipe introuvable.');
    const isStaff = STAFF_ROLES.includes(user?.roleUser ?? '');
    if (team.captainId !== user?.id && !isStaff) {
      throw new ForbiddenException('Action réservée au capitaine de l\'équipe.');
    }
    return team;
  }

  async update(
    id: string,
    dto: UpdateTeamDto,
    user?: { id?: string; roleUser?: string },
  ) {
    await this.assertCanManage(id, user);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.tag !== undefined) data.tag = dto.tag;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.logo !== undefined) data.logo = dto.logo;
    if (dto.maxMembers !== undefined) data.maxMembers = dto.maxMembers;
    if (dto.region !== undefined) data.region = dto.region;
    if (dto.isRecruiting !== undefined) data.isRecruiting = dto.isRecruiting;
    if (dto.lookingFor !== undefined) data.lookingFor = toJson(dto.lookingFor);
    if (dto.achievements !== undefined)
      data.achievements = toJson(dto.achievements);

    const team = await this.prisma.team.update({ where: { id }, data });
    return this.serialize(team);
  }

  async remove(id: string, user?: { id?: string; roleUser?: string }) {
    await this.assertCanManage(id, user);
    await this.prisma.team.delete({ where: { id } });
    return { success: true };
  }
}
