import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hydrate, toJson } from '../common/utils/json.util';
import { CreateEventDto } from './dto/create-event.dto';

function serialize(event: any) {
  if (!event) return event;
  return hydrate(event, ['participants']);
}

@Injectable()
export class EventsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const events = await this.prisma.event.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return events.map(serialize);
  }

  async findOne(id: string) {
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event) throw new NotFoundException('Événement introuvable.');
    return serialize(event);
  }

  async create(dto: CreateEventDto) {
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,
        type: dto.type,
        description: dto.description,
        date: dto.date,
        time: dto.time,
        duration: dto.duration,
        participants: toJson(dto.participants ?? []),
        organizer: dto.organizer,
        ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
        city: dto.city?.trim() || null,
      },
    });
    return serialize(event);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.event.delete({ where: { id } });
    return { success: true };
  }
}
