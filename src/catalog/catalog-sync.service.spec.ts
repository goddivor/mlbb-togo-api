import { CatalogSyncService, CATALOG_SOURCES } from './catalog-sync.service';
import { GmsClient, GmsError } from '../mlbb/gms.client';
import { PrismaService } from '../prisma/prisma.service';

const delegate = (rows: any[] = []) => ({
  findMany: jest.fn().mockResolvedValue(rows),
  create: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({}),
});

const records: Record<string, any[]> = {
  [CATALOG_SOURCES.itemDetails]: [
    { data: { equipid: 3008, equipname: 'Blade of Despair', equipicon: 'https://i/bod.png', equiptips: '+160 Attack<br>', equiptypename: 'Attack' } },
    { data: { equipid: 1001, equipname: 'Dagger', equipicon: 'https://i/dagger.png', equiptips: '+15 Attack<br>', equiptypename: 'Attack' } },
  ],
  [CATALOG_SOURCES.items]: [],
  [CATALOG_SOURCES.battleSpells]: [
    { data: { battleskillid: 20100, __data: { skillname: 'Flicker', skillicon: 'https://i/flicker.png', skilldesc: 'Blink.' } } },
  ],
  [CATALOG_SOURCES.emblems]: [{ data: { emblem_id: 20003, emblem_title: 'Tank', emblem_icon: 'https://i/tank.svg' } }],
};

describe('CatalogSyncService', () => {
  let prisma: { item: ReturnType<typeof delegate>; emblem: ReturnType<typeof delegate>; battleSpell: ReturnType<typeof delegate> };
  let gms: { callSource: jest.Mock };
  let service: CatalogSyncService;

  beforeEach(() => {
    prisma = {
      item: delegate([{ id: 'i1', name: 'Blade of Despair', icon: null, description: null, type: 'attack' }]),
      emblem: delegate([{ id: 'e1', name: 'Tank Emblem', icon: null, description: null, type: 'tank' }]),
      battleSpell: delegate([]),
    };
    gms = { callSource: jest.fn(async (_app: string, source: string) => ({ records: records[source] ?? [], total: 0 })) };
    service = new CatalogSyncService(prisma as unknown as PrismaService, gms as unknown as GmsClient);
  });

  it('upserts the three catalogs and returns counts', async () => {
    const res = await service.sync();
    expect(res.items).toEqual({ total: 2, created: 1, updated: 1, unchanged: 0, failed: 0 });
    expect(res.emblems).toMatchObject({ total: 1, updated: 1 });
    expect(res.battleSpells).toMatchObject({ total: 1, created: 1 });
    expect(prisma.item.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: expect.objectContaining({ gameId: 3008, icon: 'https://i/bod.png' }),
    });
    expect(prisma.item.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Dagger', gameId: 1001 }) });
    expect(gms.callSource).toHaveBeenCalledWith('2713644', CATALOG_SOURCES.itemDetails, expect.any(Object), 'en', expect.any(Object));
  });

  it('counts a failed write without aborting the sync', async () => {
    prisma.item.create.mockRejectedValueOnce(new Error('P2002'));
    const res = await service.sync();
    expect(res.items.failed).toBe(1);
    expect(res.battleSpells.created).toBe(1);
  });

  it('propagates a Moonton failure (mapped to 503 by the controller)', async () => {
    gms.callSource.mockRejectedValue(new GmsError('down'));
    await expect(service.sync()).rejects.toBeInstanceOf(GmsError);
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it('shares a run between concurrent calls', async () => {
    await Promise.all([service.sync(), service.sync()]);
    expect(prisma.item.findMany).toHaveBeenCalledTimes(1);
  });
});
