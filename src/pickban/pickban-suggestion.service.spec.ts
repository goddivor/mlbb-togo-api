import { Test, TestingModule } from '@nestjs/testing';
import { PickBanSuggestionService } from './pickban-suggestion.service';

describe('PickBanSuggestionService', () => {
  let service: PickBanSuggestionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PickBanSuggestionService],
    }).compile();

    service = module.get<PickBanSuggestionService>(PickBanSuggestionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('suggestHeroes', () => {
    it('should suggest heroes based on lane coverage', () => {
      const heroes = [
        { id: '1', name: 'Marksman A', role: 'marksman', laneKeys: ['gold'] },
        { id: '2', name: 'Mage B', role: 'mage', laneKeys: ['mid'] },
        { id: '3', name: 'Fighter C', role: 'fighter', laneKeys: ['exp', 'jungle'] },
      ];

      const counters = new Map();
      counters.set('1', { heroId: '1', strong: [], weak: [] });
      counters.set('2', { heroId: '2', strong: [], weak: [] });
      counters.set('3', { heroId: '3', strong: [], weak: [] });

      const suggestions = service.suggestHeroes(heroes, counters, {
        action: 'pick',
        team: 'blue',
        pickedHeroIds: new Set(),
        bannedHeroIds: new Set(),
        allyPicks: [],
        enemyPicks: [],
        allyBans: [],
        enemyBans: [],
        uncoveredLanes: new Set(['gold', 'mid', 'jungle', 'exp', 'roam']),
      });

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].heroId).toBeDefined();
      expect(suggestions[0].reason).toBeDefined();
      expect(suggestions[0].score).toBeGreaterThan(0);
    });

    it('should prioritize counters to enemy picks', () => {
      const heroes = [
        { id: '1', name: 'Ling', role: 'assassin' },
        { id: '2', name: 'Counter Ling', role: 'tank' },
        { id: '3', name: 'Random', role: 'mage' },
      ];

      const counters = new Map();
      // Counter Ling (id='2') counters Ling (id='1')
      counters.set('1', { heroId: '1', strong: [], weak: ['2'] });
      counters.set('2', { heroId: '2', strong: ['1'], weak: [] });
      counters.set('3', { heroId: '3', strong: [], weak: [] });

      const suggestions = service.suggestHeroes(heroes, counters, {
        action: 'pick',
        team: 'blue',
        pickedHeroIds: new Set(),
        bannedHeroIds: new Set(),
        allyPicks: [],
        enemyPicks: ['1'], // Enemy picked Ling
        allyBans: [],
        enemyBans: [],
        uncoveredLanes: new Set(),
      });

      // Counter Ling should be suggested first
      const counterLing = suggestions.find((s) => s.heroId === '2');
      expect(counterLing).toBeDefined();
      expect(counterLing?.reason).toContain('Ling');
    });

    it('should exclude already picked heroes', () => {
      const heroes = [
        { id: '1', name: 'Hero 1', role: 'fighter' },
        { id: '2', name: 'Hero 2', role: 'mage' },
      ];

      const counters = new Map();
      counters.set('1', { heroId: '1', strong: [], weak: [] });
      counters.set('2', { heroId: '2', strong: [], weak: [] });

      const suggestions = service.suggestHeroes(heroes, counters, {
        action: 'pick',
        team: 'blue',
        pickedHeroIds: new Set(['1']), // Hero 1 already picked
        bannedHeroIds: new Set(),
        allyPicks: [],
        enemyPicks: [],
        allyBans: [],
        enemyBans: [],
        uncoveredLanes: new Set(),
      });

      expect(suggestions.find((s) => s.heroId === '1')).toBeUndefined();
    });

    it('should prioritize high ban rate for banning', () => {
      const heroes = [
        {
          id: '1',
          name: 'OP Hero',
          role: 'fighter',
          stats: { banRate: 80, pickRate: 70, winRate: 55 },
        },
        {
          id: '2',
          name: 'Normal Hero',
          role: 'mage',
          stats: { banRate: 20, pickRate: 30, winRate: 50 },
        },
      ];

      const counters = new Map();
      counters.set('1', { heroId: '1', strong: [], weak: [] });
      counters.set('2', { heroId: '2', strong: [], weak: [] });

      const suggestions = service.suggestHeroes(heroes, counters, {
        action: 'ban',
        team: 'blue',
        pickedHeroIds: new Set(),
        bannedHeroIds: new Set(),
        allyPicks: [],
        enemyPicks: [],
        allyBans: [],
        enemyBans: [],
        uncoveredLanes: new Set(),
      });

      const opHero = suggestions.find((s) => s.heroId === '1');
      expect(opHero).toBeDefined();
      expect(opHero?.score).toBeGreaterThan(
        suggestions.find((s) => s.heroId === '2')?.score || 0,
      );
    });

    it('should return at most 5 suggestions', () => {
      const heroes = Array.from({ length: 20 }, (_, i) => ({
        id: String(i + 1),
        name: `Hero ${i + 1}`,
        role: 'fighter',
      }));

      const counters = new Map();
      heroes.forEach((h) => {
        counters.set(h.id, { heroId: h.id, strong: [], weak: [] });
      });

      const suggestions = service.suggestHeroes(heroes, counters, {
        action: 'pick',
        team: 'blue',
        pickedHeroIds: new Set(),
        bannedHeroIds: new Set(),
        allyPicks: [],
        enemyPicks: [],
        allyBans: [],
        enemyBans: [],
        uncoveredLanes: new Set(),
      });

      expect(suggestions.length).toBeLessThanOrEqual(5);
    });
  });
});
