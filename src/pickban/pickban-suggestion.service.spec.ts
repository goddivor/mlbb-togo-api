import {
  HeroCandidate,
  MATRIX_CAP,
  PickBanSuggestionService,
  PickedHeroMeta,
  SuggestionContext,
  WEIGHTS,
  toPickedMeta,
} from './pickban-suggestion.service';

const hero = (id: string, extra: Partial<HeroCandidate> = {}): HeroCandidate => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  laneKeys: [],
  ...extra,
});

const meta = (heroId: string, m: Partial<PickedHeroMeta> = {}): PickedHeroMeta => ({
  heroId,
  strongAgainst: [],
  weakAgainst: [],
  bestTeammates: [],
  ...m,
});

const ctx = (over: Partial<SuggestionContext> = {}): SuggestionContext => ({
  action: 'pick',
  team: 'blue',
  allyPicks: [],
  enemyPicks: [],
  excluded: new Set(),
  pickedMeta: new Map(),
  metaAvailable: true,
  ...over,
});

describe('PickBanSuggestionService', () => {
  const service = new PickBanSuggestionService();

  it('uses the explicit lane of an ally pick for lane coverage', () => {
    const heroes = [hero('hayabusa', { laneKeys: ['jungle'] }), hero('ling', { laneKeys: ['jungle'] })];
    const byId = new Map(heroes.map((h) => [h.id, h]));
    const byDefault = service.uncoveredLanes(['hayabusa'], byId);
    expect(byDefault.has('jungle')).toBe(false);
    expect(byDefault.has('roam')).toBe(true);
    const offLane = service.uncoveredLanes(['hayabusa'], byId, { hayabusa: 'roam' });
    expect(offLane.has('roam')).toBe(false);
    expect(offLane.has('jungle')).toBe(true);
  });

  it('never suggests picked or banned heroes and returns at most `limit` items', () => {
    const heroes = Array.from({ length: 12 }, (_, i) => hero(`h${i}`));
    const out = service.suggest(heroes, ctx({ excluded: new Set(['h0', 'h1']) }), 5);
    expect(out).toHaveLength(5);
    expect(out.map((s) => s.heroId)).not.toContain('h0');
    expect(out.map((s) => s.heroId)).not.toContain('h1');
  });

  it('ranks a hero that counters an enemy pick first and explains why', () => {
    const heroes = [hero('ling'), hero('khufra'), hero('layla')];
    const out = service.suggest(
      heroes,
      ctx({
        enemyPicks: ['ling'],
        excluded: new Set(['ling']),
        pickedMeta: new Map([['ling', meta('ling', { weakAgainst: ['khufra'] })]]),
      }),
    );
    expect(out[0].heroId).toBe('khufra');
    expect(out[0].reason).toContain('counters Ling');
  });

  it('penalizes a hero the enemy pick is strong against', () => {
    const heroes = [hero('ling'), hero('layla'), hero('nana')];
    const out = service.suggest(
      heroes,
      ctx({
        enemyPicks: ['ling'],
        excluded: new Set(['ling']),
        pickedMeta: new Map([['ling', meta('ling', { strongAgainst: ['layla'] })]]),
      }),
    );
    const layla = out.find((s) => s.heroId === 'layla')!;
    const nana = out.find((s) => s.heroId === 'nana')!;
    expect(layla.score).toBeLessThan(nana.score);
    expect(layla.reason).toContain('countered by Ling');
  });

  it('rewards synergy with ally picks', () => {
    const heroes = [hero('angela'), hero('chou'), hero('miya')];
    const out = service.suggest(
      heroes,
      ctx({
        allyPicks: ['angela'],
        excluded: new Set(['angela']),
        pickedMeta: new Map([['angela', meta('angela', { bestTeammates: ['chou'] })]]),
      }),
    );
    expect(out[0].heroId).toBe('chou');
    expect(out[0].reason).toContain('synergy with Angela');
  });

  it('prefers heroes that cover a lane the team is still missing', () => {
    const heroes = [
      hero('miya', { laneKeys: ['gold'] }),
      hero('nana', { laneKeys: ['mid'] }),
      hero('claude', { laneKeys: ['gold'] }),
    ];
    const out = service.suggest(
      heroes,
      ctx({ allyPicks: ['miya'], excluded: new Set(['miya']) }),
    );
    expect(out[0].heroId).toBe('nana');
    expect(out[0].reason).toContain('covers Mid lane');
    expect(out.find((s) => s.heroId === 'claude')!.reason).not.toContain('covers');
  });

  it('falls back to win rate when no meta is available', () => {
    const heroes = [
      hero('weak', { winRate: 45 }),
      hero('strong', { winRate: 56 }),
      hero('avg', { winRate: 50 }),
    ];
    const out = service.suggest(heroes, ctx({ metaAvailable: false }));
    expect(out[0].heroId).toBe('strong');
    expect(out[0].reason).toContain('56.0% win rate');
    expect(out[2].heroId).toBe('weak');
  });

  it('for bans, prioritizes heroes that counter our picks and high ban rates', () => {
    const heroes = [
      hero('tigreal'),
      hero('fanny', { banRate: 60 }),
      hero('layla', { banRate: 2 }),
      hero('lancelot'),
    ];
    const out = service.suggest(
      heroes,
      ctx({
        action: 'ban',
        allyPicks: ['tigreal'],
        excluded: new Set(['tigreal']),
        pickedMeta: new Map([['tigreal', meta('tigreal', { weakAgainst: ['lancelot'] })]]),
      }),
    );
    expect(out[0].heroId).toBe('lancelot');
    expect(out[0].reason).toContain('counters your Tigreal');
    expect(out[1].heroId).toBe('fanny');
    expect(out[1].reason).toContain('60% ban rate');
  });

  it('uses a stable alphabetical tie-break', () => {
    const heroes = [hero('zilong'), hero('alice'), hero('miya')];
    const out = service.suggest(heroes, ctx());
    expect(out.map((s) => s.heroId)).toEqual(['alice', 'miya', 'zilong']);
  });

  describe('full matchup matrix', () => {
    const matrixMeta = (
      heroId: string,
      vsEnemy: Record<string, number> = {},
      withAlly: Record<string, number> = {},
    ): PickedHeroMeta =>
      meta(heroId, {
        vsEnemy: new Map(Object.entries(vsEnemy)),
        withAlly: new Map(Object.entries(withAlly)),
      });

    it('scores every candidate against every enemy, not only the top 5', () => {
      // Ling's win rate drops 4 points vs Khufra, 2 vs Saber, rises 3 vs Layla.
      const heroes = [hero('ling'), hero('khufra'), hero('saber'), hero('layla'), hero('nana')];
      const out = service.suggest(
        heroes,
        ctx({
          enemyPicks: ['ling'],
          excluded: new Set(['ling']),
          pickedMeta: new Map([['ling', matrixMeta('ling', { khufra: -4, saber: -2, layla: 3, nana: 0.5 })]]),
        }),
        4,
      );
      expect(out.map((s) => s.heroId)).toEqual(['khufra', 'saber', 'nana', 'layla']);
      expect(out[0].reason).toContain('counters Ling');
      expect(out[0].score).toBe(Math.round(4 * WEIGHTS.matrixCounter));
      expect(out[3].reason).toContain('countered by Ling');
      expect(out[2].reason).not.toContain('Ling'); // below the reason threshold
    });

    it('sums the edges over several enemies and caps outliers', () => {
      const heroes = [hero('a'), hero('b'), hero('x'), hero('y')];
      const out = service.suggest(
        heroes,
        ctx({
          enemyPicks: ['a', 'b'],
          excluded: new Set(['a', 'b']),
          pickedMeta: new Map([
            ['a', matrixMeta('a', { x: -3, y: -40 })],
            ['b', matrixMeta('b', { x: -3, y: 2 })],
          ]),
        }),
      );
      const x = out.find((s) => s.heroId === 'x')!;
      const y = out.find((s) => s.heroId === 'y')!;
      expect(x.score).toBe(6 * WEIGHTS.matrixCounter);
      expect(y.score).toBe((MATRIX_CAP - 2) * WEIGHTS.matrixCounter);
      expect(x.reason).toContain('counters A, B');
    });

    it('rewards matrix synergy with ally picks', () => {
      const heroes = [hero('angela'), hero('chou'), hero('miya')];
      const out = service.suggest(
        heroes,
        ctx({
          allyPicks: ['angela'],
          excluded: new Set(['angela']),
          pickedMeta: new Map([['angela', matrixMeta('angela', {}, { chou: 3, miya: -1 })]]),
        }),
      );
      expect(out[0].heroId).toBe('chou');
      expect(out[0].reason).toContain('synergy with Angela');
      expect(out[1].score).toBe(-1 * WEIGHTS.matrixSynergy);
    });

    it('bans the heroes that hurt our picks most and pair best with enemy picks', () => {
      const heroes = [hero('tigreal'), hero('eudora'), hero('lancelot'), hero('kagura'), hero('miya')];
      const out = service.suggest(
        heroes,
        ctx({
          action: 'ban',
          allyPicks: ['tigreal'],
          enemyPicks: ['eudora'],
          excluded: new Set(['tigreal', 'eudora']),
          pickedMeta: new Map([
            ['tigreal', matrixMeta('tigreal', { lancelot: -1, kagura: -5 })],
            ['eudora', matrixMeta('eudora', {}, { lancelot: 4 })],
          ]),
        }),
      );
      expect(out[0].heroId).toBe('kagura');
      expect(out[0].reason).toContain('counters your Tigreal');
      expect(out[1].heroId).toBe('lancelot');
      expect(out[1].reason).toContain('pairs with enemy Eudora');
    });

    it('toPickedMeta maps Moonton ids to our ids and derives the top lists', () => {
      const byMoontonId = new Map([
        [1, 'self'],
        [2, 'khufra'],
        [3, 'layla'],
        [4, 'angela'],
      ]);
      const m = toPickedMeta(
        'self',
        [
          { heroId: 3, increaseWinRate: 2.5 },
          { heroId: 2, increaseWinRate: -4 },
          { heroId: 1, increaseWinRate: 0 },
          { heroId: 99, increaseWinRate: -9 }, // not in our catalog
        ],
        [{ heroId: 4, increaseWinRate: 3 }],
        byMoontonId,
      )!;
      expect(m.strongAgainst).toEqual(['layla']);
      expect(m.weakAgainst).toEqual(['khufra']);
      expect(m.bestTeammates).toEqual(['angela']);
      expect([...m.vsEnemy!.entries()]).toEqual([
        ['layla', 2.5],
        ['khufra', -4],
      ]);
      expect(toPickedMeta('self', [], [], byMoontonId)).toBeNull();
    });
  });
});
