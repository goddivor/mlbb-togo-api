import { ItemsService } from './items.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ItemsService', () => {
  let service: ItemsService;
  let prisma: { item: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock } };

  const itemRow = (over: Partial<Record<string, any>> = {}) => ({
    id: '761ff52b8e6dd373fdf291a1',
    name: 'Boots',
    description: 'Increase movement speed',
    icon: 'https://example.com/boots.png',
    type: 'movement',
    gold: 390,
    sort: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      item: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new ItemsService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('returns all items sorted by sort and name', async () => {
      const items = [itemRow({ sort: 0, name: 'Boots' }), itemRow({ id: '38d3f385ea8d8bb2dcfc759a', sort: 1, name: 'Armor' })];
      prisma.item.findMany.mockResolvedValue(items);

      const result = await service.findAll();

      expect(result).toEqual(items);
      expect(prisma.item.findMany).toHaveBeenCalledWith({
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      });
    });
  });

  describe('findOne', () => {
    it('returns the item when found', async () => {
      const item = itemRow();
      prisma.item.findUnique.mockResolvedValue(item);

      const result = await service.findOne('761ff52b8e6dd373fdf291a1');

      expect(result).toEqual(item);
      expect(prisma.item.findUnique).toHaveBeenCalledWith({ where: { id: '761ff52b8e6dd373fdf291a1' } });
    });

    it('throws NotFoundException when item not found', async () => {
      prisma.item.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll visibility', () => {
    it('hides disabled items from the public list, keeps rows without the flag', async () => {
      const rows = [itemRow({ name: 'A' }), itemRow({ name: 'B', enabled: false }), itemRow({ name: 'C', enabled: true })];
      prisma.item.findMany.mockResolvedValue(rows);

      expect((await service.findAll()).map((r: any) => r.name)).toEqual(['A', 'C']);
      expect((await service.findAll(true)).map((r: any) => r.name)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('create', () => {
    it('creates a new item', async () => {
      const newItem = itemRow();
      prisma.item.create.mockResolvedValue(newItem);

      const result = await service.create({ name: 'Boots', type: 'movement', gold: 390 });

      expect(result).toEqual(newItem);
      expect(prisma.item.create).toHaveBeenCalledWith({
        data: {
          name: 'Boots',
          type: 'movement',
          gold: 390,
          sort: 0,
          enabled: true,
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
    it('updates an item', async () => {
      const updated = itemRow({ name: 'Magic Boots' });
      prisma.item.findUnique.mockResolvedValue(itemRow());
      prisma.item.update.mockResolvedValue(updated);

      const result = await service.update('761ff52b8e6dd373fdf291a1', { name: 'Magic Boots' });

      expect(result).toEqual(updated);
      expect(prisma.item.update).toHaveBeenCalledWith({
        where: { id: '761ff52b8e6dd373fdf291a1' },
        data: { name: 'Magic Boots', sort: undefined, description: undefined, icon: undefined, type: undefined, gold: undefined },
      });
    });

    it('throws NotFoundException if item does not exist', async () => {
      prisma.item.findUnique.mockResolvedValue(null);

      await expect(service.update('nonexistent', { name: 'New' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('deletes an item', async () => {
      prisma.item.findUnique.mockResolvedValue(itemRow());
      prisma.item.delete.mockResolvedValue({});

      const result = await service.delete('761ff52b8e6dd373fdf291a1');

      expect(result).toEqual({ success: true });
      expect(prisma.item.delete).toHaveBeenCalledWith({ where: { id: '761ff52b8e6dd373fdf291a1' } });
    });

    it('throws NotFoundException if item does not exist', async () => {
      prisma.item.findUnique.mockResolvedValue(null);

      await expect(service.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
