import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { CreateLogDto } from './dto/create-log.dto';
import { CreateFormDto } from './dto/create-form.dto';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async getStats() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      totalTeams,
      totalTournaments,
      totalPosts,
      activeUsers,
      totalMatches,
      onlineNow,
      newUsersToday,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.team.count(),
      this.prisma.tournament.count(),
      this.prisma.post.count(),
      this.prisma.user.count({ where: { isBanned: false } }),
      this.prisma.match.count(),
      this.prisma.user.count({ where: { isOnline: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
    ]);

    return {
      totalUsers,
      totalTeams,
      totalTournaments,
      totalPosts,
      activeUsers,
      totalMatches,
      onlineNow,
      newUsersToday,
    };
  }

  async findAllLogs() {
    return this.prisma.adminLog.findMany({
      orderBy: { timestamp: 'desc' },
    });
  }

  async createLog(dto: CreateLogDto) {
    return this.prisma.adminLog.create({
      data: {
        action: dto.action,
        admin: dto.admin,
        target: dto.target ?? undefined,
        details: dto.details ?? undefined,
      },
    });
  }

  private serializeForm(form: any, responsesCount?: number) {
    return {
      ...form,
      fields: parseJson<any[]>(form.fields, []),
      ...(responsesCount !== undefined ? { responses: responsesCount } : {}),
    };
  }

  async findAllForms() {
    const forms = await this.prisma.formTemplate.findMany({
      include: { _count: { select: { responses: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return forms.map((form) => {
      const { _count, ...rest } = form as any;
      return this.serializeForm(rest, _count.responses);
    });
  }

  async findOneForm(id: string) {
    const form = await this.prisma.formTemplate.findUnique({ where: { id } });
    if (!form) throw new NotFoundException('Formulaire introuvable.');
    return this.serializeForm(form);
  }

  async createForm(dto: CreateFormDto) {
    const form = await this.prisma.formTemplate.create({
      data: {
        name: dto.name,
        description: dto.description ?? undefined,
        fields: toJson(dto.fields ?? []),
      },
    });
    return this.serializeForm(form);
  }

  async updateForm(id: string, dto: Partial<CreateFormDto>) {
    await this.findOneForm(id);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.fields !== undefined) data.fields = toJson(dto.fields);

    const form = await this.prisma.formTemplate.update({ where: { id }, data });
    return this.serializeForm(form);
  }

  async removeForm(id: string) {
    await this.findOneForm(id);
    await this.prisma.formTemplate.delete({ where: { id } });
    return { success: true };
  }

  async findResponses(formId: string) {
    await this.findOneForm(formId);
    const responses = await this.prisma.formResponse.findMany({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
    });
    return responses.map((r) => ({
      ...r,
      data: parseJson<Record<string, any>>(r.data, {}),
    }));
  }

  async createResponse(formId: string, data: Record<string, any>) {
    await this.findOneForm(formId);
    const response = await this.prisma.formResponse.create({
      data: {
        formId,
        data: toJson(data ?? {}),
      },
    });
    return {
      ...response,
      data: parseJson<Record<string, any>>(response.data, {}),
    };
  }
}
