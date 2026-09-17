import {
  HeroCandidate,
  PickBanSuggestionService,
  PickedHeroMeta,
  SuggestionContext,
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
});
