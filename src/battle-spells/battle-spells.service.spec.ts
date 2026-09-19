import { BattleSpellsService } from './battle-spells.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('BattleSpellsService', () => {
  let service: BattleSpellsService;
  let prisma: { battleSpell: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock } };

  const spellRow = (over: Partial<Record<string, any>> = {}) => ({
    id: '512ba84036de22a8b4f3a617',
    name: 'Flicker',
    description: 'Short dash in target direction',
    icon: 'https://example.com/flicker.png',
    cooldown: '30s',
    sort: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      battleSpell: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new BattleSpellsService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('returns all battle spells sorted by sort and name', async () => {
      const spells = [spellRow(), spellRow({ id: '4963feaa37a710ef8eac8561', sort: 1, name: 'Retribution' })];
      prisma.battleSpell.findMany.mockResolvedValue(spells);

      const result = await service.findAll();

      expect(result).toEqual(spells);
      expect(prisma.battleSpell.findMany).toHaveBeenCalledWith({
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      });
    });
  });

  describe('findOne', () => {
    it('returns the battle spell when found', async () => {
      const spell = spellRow();
      prisma.battleSpell.findUnique.mockResolvedValue(spell);

      const result = await service.findOne('512ba84036de22a8b4f3a617');

      expect(result).toEqual(spell);
    });

    it('throws NotFoundException when not found', async () => {
      prisma.battleSpell.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a new battle spell', async () => {
      const newSpell = spellRow();
      prisma.battleSpell.create.mockResolvedValue(newSpell);

      const result = await service.create({ name: 'Flicker', cooldown: '30s' });

      expect(result).toEqual(newSpell);
      expect(prisma.battleSpell.create).toHaveBeenCalledWith({
        data: {
          name: 'Flicker',
          cooldown: '30s',
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
    it('updates a battle spell', async () => {
      const updated = spellRow({ name: 'Flicker Enhanced' });
      prisma.battleSpell.findUnique.mockResolvedValue(spellRow());
      prisma.battleSpell.update.mockResolvedValue(updated);

      const result = await service.update('512ba84036de22a8b4f3a617', { name: 'Flicker Enhanced' });

      expect(result).toEqual(updated);
    });

    it('throws NotFoundException if spell does not exist', async () => {
      prisma.battleSpell.findUnique.mockResolvedValue(null);

      await expect(service.update('nonexistent', { name: 'New' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('deletes a battle spell', async () => {
      prisma.battleSpell.findUnique.mockResolvedValue(spellRow());
      prisma.battleSpell.delete.mockResolvedValue({});

      const result = await service.delete('512ba84036de22a8b4f3a617');

      expect(result).toEqual({ success: true });
    });

    it('throws NotFoundException if spell does not exist', async () => {
      prisma.battleSpell.findUnique.mockResolvedValue(null);

      await expect(service.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
