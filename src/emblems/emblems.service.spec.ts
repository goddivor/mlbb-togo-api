import { EmblemsService } from './emblems.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('EmblemsService', () => {
  let service: EmblemsService;
  let prisma: { emblem: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock } };

  const emblemRow = (over: Partial<Record<string, any>> = {}) => ({
    id: '1547720428ab3e7fab3275ef',
    name: 'Support',
    description: 'Support emblem',
    icon: 'https://example.com/emblem.png',
    type: 'support',
    sort: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      emblem: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new EmblemsService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('returns all emblems sorted by sort and name', async () => {
      const emblems = [emblemRow(), emblemRow({ id: '24cac431b1bc7996ae37f0b0', sort: 1, name: 'Order' })];
      prisma.emblem.findMany.mockResolvedValue(emblems);

      const result = await service.findAll();

      expect(result).toEqual(emblems);
      expect(prisma.emblem.findMany).toHaveBeenCalledWith({
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      });
    });
  });

  describe('findOne', () => {
    it('returns the emblem when found', async () => {
      const emblem = emblemRow();
      prisma.emblem.findUnique.mockResolvedValue(emblem);

      const result = await service.findOne('1547720428ab3e7fab3275ef');

      expect(result).toEqual(emblem);
    });

    it('throws NotFoundException when not found', async () => {
      prisma.emblem.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a new emblem', async () => {
      const newEmblem = emblemRow();
      prisma.emblem.create.mockResolvedValue(newEmblem);

      const result = await service.create({ name: 'Support', type: 'support' });

      expect(result).toEqual(newEmblem);
      expect(prisma.emblem.create).toHaveBeenCalledWith({
        data: {
          name: 'Support',
          type: 'support',
          sort: 0,
          description: undefined,
          icon: undefined,
        },
      });
    });

    it('throws BadRequestException when name is empty', async () => {
      await expect(service.create({ name: '   ' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('updates an emblem', async () => {
      const updated = emblemRow({ name: 'Order Emblem' });
      prisma.emblem.findUnique.mockResolvedValue(emblemRow());
      prisma.emblem.update.mockResolvedValue(updated);

      const result = await service.update('1547720428ab3e7fab3275ef', { name: 'Order Emblem' });

      expect(result).toEqual(updated);
    });

    it('throws NotFoundException if emblem does not exist', async () => {
      prisma.emblem.findUnique.mockResolvedValue(null);

      await expect(service.update('nonexistent', { name: 'New' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('deletes an emblem', async () => {
      prisma.emblem.findUnique.mockResolvedValue(emblemRow());
      prisma.emblem.delete.mockResolvedValue({});

      const result = await service.delete('1547720428ab3e7fab3275ef');

      expect(result).toEqual({ success: true });
    });

    it('throws NotFoundException if emblem does not exist', async () => {
      prisma.emblem.findUnique.mockResolvedValue(null);

      await expect(service.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
