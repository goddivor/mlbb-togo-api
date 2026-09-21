import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBattleSpellDto, UpdateBattleSpellDto } from './dto/battle-spell.dto';

/** Maps the unique-name violation to a 409 instead of a 500. */
const uniqueName = (error: any): never => {
  if (error?.code === 'P2002') throw new ConflictException('Battle spell name already exists.');
  throw error;
};


@Injectable()
export class BattleSpellsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Catalog list. Disabled entries (`enabled: false`) are hidden from players
   * and pickers; admins list them with `includeDisabled`. A missing flag
   * (rows created before it existed) means enabled.
   */
  async findAll(includeDisabled = false) {
    const rows = await this.prisma.battleSpell.findMany({
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });
    return includeDisabled ? rows : rows.filter((r) => r.enabled !== false);
  }

  async findOne(id: string) {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw new NotFoundException('Not found.');
    const spell = await this.prisma.battleSpell.findUnique({
      where: { id },
    });
    if (!spell) throw new NotFoundException('Battle spell not found.');
    return spell;
  }

  async create(data: CreateBattleSpellDto) {
    if (!data.name?.trim()) throw new BadRequestException('Battle spell name is required.');
    return this.prisma.battleSpell.create({
      data: {
        name: data.name,
        description: data.description || undefined,
        icon: data.icon || undefined,
        cooldown: data.cooldown || undefined,
        sort: data.sort ?? 0,
        enabled: data.enabled ?? true,
      },
    }).catch(uniqueName);
  }

  async update(id: string, data: UpdateBattleSpellDto) {
    await this.findOne(id);
    return this.prisma.battleSpell.update({
      where: { id },
      data: {
        name: data.name !== undefined ? data.name : undefined,
        description: data.description !== undefined ? data.description : undefined,
        icon: data.icon !== undefined ? data.icon : undefined,
        cooldown: data.cooldown !== undefined ? data.cooldown : undefined,
        sort: data.sort !== undefined ? data.sort : undefined,
        enabled: data.enabled !== undefined ? data.enabled : undefined,
      },
    }).catch(uniqueName);
  }

  async delete(id: string) {
    await this.findOne(id);
    await this.prisma.battleSpell.delete({ where: { id } });
    return { success: true };
  }
}
