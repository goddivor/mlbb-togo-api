import { BuildsService } from './builds.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('BuildsService', () => {
  let service: BuildsService;
  let prisma: {
    heroBuild: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    hero: { findUnique: jest.Mock; findFirst: jest.Mock };
    item: { findMany: jest.Mock };
    emblem: { findUnique: jest.Mock };
    battleSpell: { findUnique: jest.Mock };
  };

  const buildRow = (over: Partial<Record<string, any>> = {}) => ({
    id: 'da7cd64ac19cf38e769a5ab3',
    heroId: 'de1b7f908943290b1d96caf1',
    heroName: 'Ling',
    name: 'Burst Build',
    description: 'High damage burst',
    itemIds: ['761ff52b8e6dd373fdf291a1', '38d3f385ea8d8bb2dcfc759a'],
    emblemId: '1547720428ab3e7fab3275ef',
    battleSpellId: '512ba84036de22a8b4f3a617',
    priority: 1,
    sort: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  const itemRow = (id: string = '761ff52b8e6dd373fdf291a1') => ({ id, name: 'Boots', gold: 390 });
  const emblemRow = () => ({ id: '1547720428ab3e7fab3275ef', name: 'Support' });
  const spellRow = () => ({ id: '512ba84036de22a8b4f3a617', name: 'Flicker' });
  const heroRow = (id: string = 'de1b7f908943290b1d96caf1') => ({ id, name: 'Ling' });

  beforeEach(() => {
    prisma = {
      heroBuild: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      hero: { findUnique: jest.fn(), findFirst: jest.fn() },
      item: { findMany: jest.fn() },
      emblem: { findUnique: jest.fn() },
      battleSpell: { findUnique: jest.fn() },
    };
    service = new BuildsService(prisma as unknown as PrismaService);
  });

  describe('findByHero', () => {
    it('returns all builds for a hero, sorted by priority and sort', async () => {
      const builds = [buildRow(), buildRow({ id: '99a7d77824e27a42ea076d22', priority: 0 })];
      prisma.hero.findUnique.mockResolvedValue({ id: 'de1b7f908943290b1d96caf1', name: 'Layla' });
      prisma.heroBuild.findMany.mockResolvedValue(builds);
      prisma.item.findMany.mockResolvedValue([itemRow()]);
      prisma.emblem.findUnique.mockResolvedValue(emblemRow());
      prisma.battleSpell.findUnique.mockResolvedValue(spellRow());

      const result = await service.findByHero('de1b7f908943290b1d96caf1');

      expect(result).toHaveLength(2);
      expect(prisma.heroBuild.findMany).toHaveBeenCalledWith({
        where: { heroId: 'de1b7f908943290b1d96caf1' },
        orderBy: [{ priority: 'desc' }, { sort: 'asc' }],
      });
    });
  });

  describe('findOne', () => {
    it('returns an enriched build', async () => {
      const build = buildRow();
      prisma.heroBuild.findUnique.mockResolvedValue(build);
      prisma.item.findMany.mockResolvedValue([itemRow('761ff52b8e6dd373fdf291a1'), itemRow('38d3f385ea8d8bb2dcfc759a')]);
      prisma.emblem.findUnique.mockResolvedValue(emblemRow());
      prisma.battleSpell.findUnique.mockResolvedValue(spellRow());

      const result = await service.findOne('da7cd64ac19cf38e769a5ab3');

      expect(result.id).toBe('da7cd64ac19cf38e769a5ab3');
      expect(result.items).toHaveLength(2);
      expect(result.emblem.name).toBe('Support');
      expect(result.battleSpell.name).toBe('Flicker');
    });

    it('returns items in build order even when the DB returns them differently', async () => {
      prisma.heroBuild.findUnique.mockResolvedValue(buildRow());
      // Reversed compared to buildRow().itemIds.
      prisma.item.findMany.mockResolvedValue([itemRow('38d3f385ea8d8bb2dcfc759a'), itemRow('761ff52b8e6dd373fdf291a1')]);
      prisma.emblem.findUnique.mockResolvedValue(emblemRow());
      prisma.battleSpell.findUnique.mockResolvedValue(spellRow());

      const result = await service.findOne('da7cd64ac19cf38e769a5ab3');

      expect(result.items.map((i: any) => i.id)).toEqual([
        '761ff52b8e6dd373fdf291a1',
        '38d3f385ea8d8bb2dcfc759a',
      ]);
    });

    it('drops item ids that no longer exist in the catalog', async () => {
      prisma.heroBuild.findUnique.mockResolvedValue(buildRow());
      prisma.item.findMany.mockResolvedValue([itemRow('38d3f385ea8d8bb2dcfc759a')]);
      prisma.emblem.findUnique.mockResolvedValue(null);
      prisma.battleSpell.findUnique.mockResolvedValue(null);

      const result = await service.findOne('da7cd64ac19cf38e769a5ab3');

      expect(result.items.map((i: any) => i.id)).toEqual(['38d3f385ea8d8bb2dcfc759a']);
      expect(result.emblem).toBeNull();
      expect(result.battleSpell).toBeNull();
    });

    it('throws NotFoundException when build not found', async () => {
      prisma.heroBuild.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a new build for a hero', async () => {
      const newBuild = buildRow();
      const hero = heroRow();
      prisma.hero.findUnique.mockResolvedValue(hero);
      prisma.heroBuild.create.mockResolvedValue(newBuild);
      prisma.item.findMany.mockResolvedValue([
        { ...itemRow(), id: '761ff52b8e6dd373fdf291a1' },
        { ...itemRow(), id: '38d3f385ea8d8bb2dcfc759a' },
      ]);
      prisma.emblem.findUnique.mockResolvedValue(emblemRow());
      prisma.battleSpell.findUnique.mockResolvedValue(spellRow());

      const result = await service.create('de1b7f908943290b1d96caf1', {
        name: 'Burst Build',
        itemIds: ['761ff52b8e6dd373fdf291a1', '38d3f385ea8d8bb2dcfc759a'],
        emblemId: '1547720428ab3e7fab3275ef',
        battleSpellId: '512ba84036de22a8b4f3a617',
        priority: 1,
      });

      expect(result.heroName).toBe('Ling');
      expect(prisma.heroBuild.create).toHaveBeenCalledWith({
        data: {
          heroId: 'de1b7f908943290b1d96caf1',
          heroName: 'Ling',
          name: 'Burst Build',
          itemIds: ['761ff52b8e6dd373fdf291a1', '38d3f385ea8d8bb2dcfc759a'],
          emblemId: '1547720428ab3e7fab3275ef',
          battleSpellId: '512ba84036de22a8b4f3a617',
          priority: 1,
          sort: 0,
          description: undefined,
        },
      });
    });

    it('throws NotFoundException if hero does not exist', async () => {
      prisma.hero.findUnique.mockResolvedValue(null);

      await expect(service.create('nonexistent', { name: 'Build' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates a build', async () => {
      const updated = buildRow({ name: 'Updated Burst' });
      prisma.heroBuild.findUnique.mockResolvedValue(buildRow());
      prisma.heroBuild.update.mockResolvedValue(updated);
      prisma.item.findMany.mockResolvedValue([itemRow()]);
      prisma.emblem.findUnique.mockResolvedValue(emblemRow());
      prisma.battleSpell.findUnique.mockResolvedValue(spellRow());

      const result = await service.update('da7cd64ac19cf38e769a5ab3', { name: 'Updated Burst' });

      expect(result.name).toBe('Updated Burst');
    });

    it('throws NotFoundException if build does not exist', async () => {
      prisma.heroBuild.findUnique.mockResolvedValue(null);

      await expect(service.update('nonexistent', { name: 'New' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('deletes a build', async () => {
      prisma.heroBuild.findUnique.mockResolvedValue(buildRow());
      prisma.heroBuild.delete.mockResolvedValue({});

      const result = await service.delete('da7cd64ac19cf38e769a5ab3');

      expect(result).toEqual({ success: true });
      expect(prisma.heroBuild.delete).toHaveBeenCalledWith({ where: { id: 'da7cd64ac19cf38e769a5ab3' } });
    });

    it('throws NotFoundException if build does not exist', async () => {
      prisma.heroBuild.findUnique.mockResolvedValue(null);

      await expect(service.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
