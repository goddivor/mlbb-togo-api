import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateItemDto, UpdateItemDto } from './dto/item.dto';

/** Maps the unique-name violation to a 409 instead of a 500. */
const uniqueName = (error: any): never => {
  if (error?.code === 'P2002') throw new ConflictException('Item name already exists.');
  throw error;
};


@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Catalog list. Disabled entries (`enabled: false`) are hidden from players
   * and pickers; admins list them with `includeDisabled`. A missing flag
   * (rows created before it existed) means enabled.
   */
  async findAll(includeDisabled = false) {
    const rows = await this.prisma.item.findMany({
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });
    return includeDisabled ? rows : rows.filter((r) => r.enabled !== false);
  }

  async findOne(id: string) {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw new NotFoundException('Not found.');
    const item = await this.prisma.item.findUnique({
      where: { id },
    });
    if (!item) throw new NotFoundException('Item not found.');
    return item;
  }

  async create(data: CreateItemDto) {
    if (!data.name?.trim()) throw new BadRequestException('Item name is required.');
    return this.prisma.item.create({
      data: {
        name: data.name,
        description: data.description || undefined,
        icon: data.icon || undefined,
        type: data.type || undefined,
        gold: data.gold ?? undefined,
        sort: data.sort ?? 0,
        enabled: data.enabled ?? true,
      },
    }).catch(uniqueName);
  }

  async update(id: string, data: UpdateItemDto) {
    await this.findOne(id);
    return this.prisma.item.update({
      where: { id },
      data: {
        name: data.name !== undefined ? data.name : undefined,
        description: data.description !== undefined ? data.description : undefined,
        icon: data.icon !== undefined ? data.icon : undefined,
        type: data.type !== undefined ? data.type : undefined,
        gold: data.gold !== undefined ? data.gold : undefined,
        sort: data.sort !== undefined ? data.sort : undefined,
        enabled: data.enabled !== undefined ? data.enabled : undefined,
      },
    }).catch(uniqueName);
  }

  async delete(id: string) {
    await this.findOne(id);
    await this.prisma.item.delete({ where: { id } });
    return { success: true };
  }
}
