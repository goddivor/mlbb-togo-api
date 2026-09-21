import {
  buildItemRecipes,
  catalogNameKey,
  cleanGmsText,
  emblemName,
  mapGmsBattleSpells,
  mapGmsEmblems,
  mapGmsItems,
  planCatalogSync,
  SYNC_SORT_BASE,
  untouchedSinceSync,
} from './catalog-sync.mappers';

// Trimmed copies of real Moonton Academy records (app 2713644).
const itemDetail = (equipid: number, equipname: string, extra: Record<string, unknown> = {}) => ({
  data: {
    equipid,
    equipname,
    equipicon: `https://akmweb.youngjoygame.com/web/svnres/img/mlbb/homepage/100_${equipid}.png`,
    equiptips: '+160 Extra Physical Attack<br>+5% Movement Speed<br>',
    equipskilldesc:
      '\nDespair: Dealing damage to non-Minion enemies below 50% HP increases Physical Attack by 25% for 2s.',
    equiptype: '0',
    equiptypename: 'Attack',
    ...extra,
  },
});

const spellRecord = {
  data: {
    __data: {
      skilldesc: 'Teleport.\nIf interrupted, 30s of the cooldown is <font color="62f8fe">refunded</font>.',
      skillicon: 'https://akmweb.youngjoygame.com/web/svnres/img/mlbb/homepage/100_arrival.png',
      skillid: 20160,
      skillname: 'Arrival',
    },
    battleskillid: 20160,
    skillicon: '@__data.skillicon',
    skillname: '@__data.skillname1',
  },
};

const emblemRecord = (emblem_id: number, emblem_title: string) => ({
  data: {
    emblem_detail: {
      data: {
        attriicon: 'https://akmweb.youngjoygame.com/attr.png',
        emblemattr: { emblemattr: '+500 Extra Max HP\n+10 Extra Physical Defense\n', emblemname: emblem_title },
        emblemid: emblem_id,
      },
    },
    emblem_icon: `https://akmweb.youngjoygame.com/web/gms/image/${emblem_id}.svg`,
    emblem_id,
    emblem_title,
  },
});

describe('cleanGmsText', () => {
  it('strips font tags, converts <br> and drops empty header lines', () => {
    const raw =
      '\nPassive - Favor: \n: \n<font color="FFD700">Devotion</font>: Gains 35% Gold.<br>+40 Movement Speed<br>';
    expect(cleanGmsText(raw)).toBe('Devotion: Gains 35% Gold.\n+40 Movement Speed');
  });

  it('returns null for empty or non-string values', () => {
    expect(cleanGmsText('')).toBeNull();
    expect(cleanGmsText('\n: ')).toBeNull();
    expect(cleanGmsText(undefined)).toBeNull();
  });
});

describe('catalogNameKey', () => {
  it('ignores case, spacing, punctuation and the possessive variant', () => {
    expect(catalogNameKey("Haas's Claws")).toBe(catalogNameKey("Haas' Claws"));
    expect(catalogNameKey('Rapid Boots- Conceal')).toBe(catalogNameKey('rapid boots - conceal'));
    expect(catalogNameKey('Blade of Despair')).not.toBe(catalogNameKey('Blade Armor'));
    expect(catalogNameKey('Magic Shoes')).toBe(catalogNameKey('Magic Boots'));
  });
});

describe('mapGmsItems', () => {
  it('maps detail records with stats + passive description, sorted by id', () => {
    const items = mapGmsItems([itemDetail(3008, 'Blade of Despair'), itemDetail(1001, 'Dagger', { equipskilldesc: '' })]);
    expect(items.map((i) => i.gameId)).toEqual([1001, 3008]);
    expect(items[1]).toMatchObject({
      gameId: 3008,
      name: 'Blade of Despair',
      icon: 'https://akmweb.youngjoygame.com/web/svnres/img/mlbb/homepage/100_3008.png',
      description:
        '+160 Extra Physical Attack\n+5% Movement Speed\n\nDespair: Dealing damage to non-Minion enemies below 50% HP increases Physical Attack by 25% for 2s.',
      type: 'attack',
    });
    expect(items[0].description).toBe('+160 Extra Physical Attack\n+5% Movement Speed');
  });

  it('backfills a missing icon from the light list and skips retired or untranslated items', () => {
    const items = mapGmsItems(
      [
        itemDetail(2301, 'Warrior Boots', { equipicon: '' }),
        itemDetail(2010, 'Greedy Crusher (removed)'),
        itemDetail(2015, '百战神斧（已废弃）'),
        itemDetail(2301, 'Warrior Boots'),
      ],
      [{ data: { equipid: 2301, equipname: 'Warrior Boots', equipicon: 'https://x/boots.png' } }],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ gameId: 2301, icon: 'https://x/boots.png', type: 'attack' });
  });
});

describe('mapGmsBattleSpells', () => {
  it('reads the nested __data record', () => {
    expect(mapGmsBattleSpells([spellRecord])).toEqual([
      {
        gameId: 20160,
        name: 'Arrival',
        icon: 'https://akmweb.youngjoygame.com/web/svnres/img/mlbb/homepage/100_arrival.png',
        description: 'Teleport.\nIf interrupted, 30s of the cooldown is refunded.',
      },
    ]);
  });
});

describe('mapGmsEmblems', () => {
  it('names sets like the catalog ("Tank Emblem", "All" -> "Common Emblem")', () => {
    const emblems = mapGmsEmblems([emblemRecord(20003, 'Tank'), emblemRecord(20001, 'All')]);
    expect(emblems.map((e) => [e.gameId, e.name, e.type])).toEqual([
      [20001, 'Common Emblem', 'common'],
      [20003, 'Tank Emblem', 'tank'],
    ]);
    expect(emblems[1].description).toBe('+500 Extra Max HP\n+10 Extra Physical Defense');
    expect(emblems[1].icon).toContain('20003.svg');
  });

  it('keeps an explicit "Emblem" suffix', () => {
    expect(emblemName('Mage Emblem')).toBe('Mage Emblem');
  });
});

describe('untouchedSinceSync', () => {
  const t = new Date('2026-09-21T10:00:00Z');
  it('is true only when updatedAt is within the tolerance of syncedAt', () => {
    expect(untouchedSinceSync({ id: 'a', name: 'x', syncedAt: t, updatedAt: new Date(t.getTime() + 50) })).toBe(true);
    expect(untouchedSinceSync({ id: 'a', name: 'x', syncedAt: t, updatedAt: new Date(t.getTime() + 60_000) })).toBe(
      false,
    );
    expect(untouchedSinceSync({ id: 'a', name: 'x', syncedAt: null, updatedAt: t })).toBe(false);
  });
});

describe('planCatalogSync', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const before = new Date('2026-09-01T12:00:00Z');
  const cand = (gameId: number, name: string, over: Record<string, unknown> = {}) => ({
    gameId,
    name,
    icon: `icon-${gameId}`,
    description: `desc-${gameId}`,
    type: 'attack',
    ...over,
  });

  it('links a hand-seeded row by name and fills its empty icon/description, keeping id and name', () => {
    const writes = planCatalogSync(
      [cand(3002, "Haas' Claws")],
      [{ id: 'r1', name: "Haas's Claws", icon: null, description: null, type: 'attack', updatedAt: before }],
      now,
      { withType: true },
    );
    expect(writes).toEqual([
      {
        kind: 'update',
        id: 'r1',
        name: "Haas's Claws",
        data: { gameId: 3002, icon: 'icon-3002', description: 'desc-3002', syncedAt: now },
      },
    ]);
  });

  it('keeps icon/description an admin edited, and never renames', () => {
    const writes = planCatalogSync(
      [cand(3008, 'Blade of Despair')],
      [{ id: 'r1', name: 'BoD', gameId: 3008, icon: 'custom.png', description: 'mine', updatedAt: now, syncedAt: before }],
      now,
    );
    // Unmarked so later syncs never take the row over.
    expect(writes).toEqual([{ kind: 'update', id: 'r1', name: 'BoD', data: { syncedAt: null } }]);
  });

  it('never takes over an admin description kept at link time (two consecutive syncs)', () => {
    const seeded = { id: 'r1', name: 'Oracle', icon: null, description: 'Admin note', updatedAt: before };
    const [first] = planCatalogSync([cand(3204, 'Oracle')], [seeded], now);
    expect(first).toEqual({ kind: 'update', id: 'r1', name: 'Oracle', data: { gameId: 3204, icon: 'icon-3204' } });
    // Row as stored after the first write (updatedAt bumped, syncedAt untouched).
    const stored = { ...seeded, gameId: 3204, icon: 'icon-3204', updatedAt: now, syncedAt: null };
    const later = new Date(now.getTime() + 60_000);
    expect(planCatalogSync([cand(3204, 'Oracle')], [stored], later)).toEqual([
      { kind: 'unchanged', id: 'r1', name: 'Oracle' },
    ]);
  });

  it('refreshes icon/description of a row nobody edited since the last sync', () => {
    const writes = planCatalogSync(
      [cand(3008, 'Blade of Despair')],
      [{ id: 'r1', name: 'Blade of Despair', gameId: 3008, icon: 'old', description: 'old', updatedAt: before, syncedAt: before }],
      now,
    );
    expect(writes).toEqual([
      { kind: 'update', id: 'r1', name: 'Blade of Despair', data: { icon: 'icon-3008', description: 'desc-3008', syncedAt: now } },
    ]);
  });

  it('fills an empty type only when asked', () => {
    const rows = [
      { id: 'r1', name: 'Dagger', gameId: 1001, icon: 'icon-1001', description: 'desc-1001', type: null, syncedAt: before, updatedAt: before },
    ];
    expect(planCatalogSync([cand(1001, 'Dagger')], rows, now)[0].kind).toBe('unchanged');
    expect(planCatalogSync([cand(1001, 'Dagger')], rows, now, { withType: true })[0]).toMatchObject({
      kind: 'update',
      data: { type: 'attack' },
    });
  });

  it('creates missing entries after the seeded ones and never emits deletions', () => {
    const writes = planCatalogSync(
      [cand(1001, 'Dagger'), cand(1002, 'Knife')],
      [
        { id: 'r1', name: 'Dagger', gameId: 1001, icon: 'icon-1001', description: 'desc-1001', type: 'attack', syncedAt: before, updatedAt: before },
        { id: 'r2', name: 'Custom item' },
      ],
      now,
      { withType: true },
    );
    expect(writes.map((w) => w.kind)).toEqual(['unchanged', 'create']);
    expect(writes[1]).toEqual({
      kind: 'create',
      data: {
        name: 'Knife',
        icon: 'icon-1002',
        description: 'desc-1002',
        gameId: 1002,
        syncedAt: now,
        sort: SYNC_SORT_BASE + 1,
        type: 'attack',
      },
    });
  });

  it('does not steal a same-name row already linked to another Moonton id', () => {
    const writes = planCatalogSync([cand(9999, 'Dagger')], [{ id: 'r1', name: 'Dagger', gameId: 1001 }], now);
    expect(writes[0].kind).toBe('create');
  });
});

describe('buildItemRecipes / item extra fields', () => {
  const recipe = [
    itemDetail(1001, 'Dagger', { targetequipid: '2001;3008' }),
    itemDetail(2001, 'Legion Sword', { targetequipid: '3008' }),
    itemDetail(3008, 'Blade of Despair', { targetequipid: '' }),
  ];

  it('derives components, tiers and inverse links from targetequipid', () => {
    const meta = buildItemRecipes(recipe);
    expect(meta.get(1001)).toEqual({
      categoryId: 0,
      category: 'Attack',
      isComponent: true,
      tier: 1,
      buildsFrom: [],
      buildsInto: [2001, 3008],
    });
    expect(meta.get(2001)).toMatchObject({ tier: 2, buildsFrom: [1001], buildsInto: [3008] });
    expect(meta.get(3008)).toMatchObject({ isComponent: false, tier: 3, buildsFrom: [1001, 2001] });
  });

  it('exposes stats, passive and recipe JSON as Moonton-owned extra fields', () => {
    const bod = mapGmsItems(recipe).find((i) => i.gameId === 3008)!;
    expect(bod.extra!.stats).toBe('+160 Extra Physical Attack\n+5% Movement Speed');
    expect(bod.extra!.passive).toMatch(/^Despair: /);
    expect(JSON.parse(bod.extra!.gameMeta!)).toMatchObject({ tier: 3, buildsFrom: [1001, 2001] });
  });

  it('refreshes extra fields even on an edited row, and never touches enabled', () => {
    const now = new Date('2026-09-21T12:00:00Z');
    const [bod] = mapGmsItems([itemDetail(3008, 'Blade of Despair')]);
    const writes = planCatalogSync(
      [bod],
      [
        {
          id: 'r1',
          name: 'Blade of Despair',
          gameId: 3008,
          icon: 'custom.png',
          description: 'mine',
          type: 'attack',
          enabled: false,
          stats: 'old',
          updatedAt: now,
          syncedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ],
      now,
      { withType: true },
    );
    expect(writes[0].kind).toBe('update');
    const data = (writes[0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(['gameMeta', 'passive', 'stats', 'syncedAt']);
    expect(data).not.toHaveProperty('enabled');
  });

  it('creates rows without an enabled flag (schema default = enabled) but with extra fields', () => {
    const [bod] = mapGmsItems([itemDetail(3008, 'Blade of Despair')]);
    const [w] = planCatalogSync([bod], [], new Date());
    expect(w.kind).toBe('create');
    const data = (w as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('enabled');
    expect(data.stats).toBe('+160 Extra Physical Attack\n+5% Movement Speed');
  });
});
