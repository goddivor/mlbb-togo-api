import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateLaneDto } from './dto/update-lane.dto';

@Injectable()
export class LanesService {
  constructor(private prisma: PrismaService) {}

  // All lanes from the database, sorted by display order.
  async findAll() {
    return this.prisma.lane.findMany({ orderBy: { sort: 'asc' } });
  }

  // A single lane by its key (gold/exp/jungle/mid/roam).
  async findByKey(key: string) {
    const lane = await this.prisma.lane.findUnique({ where: { key } });
    if (!lane) throw new NotFoundException(`Lane "${key}" introuvable.`);
    return lane;
  }

  // Partial update (admin): only touches the provided fields.
  async update(key: string, dto: UpdateLaneDto) {
    await this.findByKey(key); // 404 if missing
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.shortName !== undefined) data.shortName = dto.shortName;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.icon !== undefined) data.icon = dto.icon;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.compatibleClasses !== undefined)
      data.compatibleClasses = dto.compatibleClasses;
    if (dto.sort !== undefined) data.sort = dto.sort;

    return this.prisma.lane.update({ where: { key }, data });
  }
}
