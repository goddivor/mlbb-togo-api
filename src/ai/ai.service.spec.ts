import { HttpException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_RATE_LIMIT, AiService } from './ai.service';
import { RateLimiter, TtlCache } from './ai-store';
import { PrismaService } from '../prisma/prisma.service';
import { MlbbService } from '../mlbb/mlbb.service';
import { HeroMetaService } from '../mlbb/hero-meta.service';
import { TOOLS } from './ai-llm';

const heroRow = (name: string, role: string, lanes: string[] = []) => ({
  id: `aaaaaaaaaaaaaaaaaaaaa${name.length.toString(16).padStart(3, '0')}`.slice(0, 24),
  name,
  role,
  roles: [role],
  laneKeys: lanes,
  image: `${name}.png`,
  thumb: null,
  heroId: null,
  speciality: [],
  stats: null,
});

const HEROES = [
  { ...heroRow('Tigreal', 'tank', ['roam']), id: '000000000000000000000001' },
  { ...heroRow('Layla', 'marksman', ['gold']), id: '000000000000000000000002' },
  { ...heroRow('Gusion', 'assassin', ['jungle']), id: '000000000000000000000003' },
  { ...heroRow('Kagura', 'mage', ['mid']), id: '000000000000000000000004' },
  { ...heroRow('Chou', 'fighter', ['exp']), id: '000000000000000000000005' },
  { ...heroRow('Angela', 'support', ['roam']), id: '000000000000000000000006' },
];

const userRow = (id: string, over: Record<string, any> = {}) => ({
  id,
  username: `u-${id}`,
  rank: 'epic',
  role: 'tank',
  wins: 30,
  losses: 20,
  mvpCount: 6,
  streak: 2,
  favoriteHeroes: '["Tigreal"]',
  gameFrequentHeroes: '[]',
  gameRoles: '[]',
  gameStats: '{}',
  ...over,
});

/** Builds a fake Anthropic Message carrying a single tool_use block. */
const toolMessage = (name: string, input: unknown) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
});

function makeService(opts: { client?: any; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const prisma = {
    user: { findUnique: jest.fn(({ where }) => Promise.resolve(where.id.startsWith('missing') ? null : userRow(where.id))) },
    hero: {
      findMany: jest.fn().mockResolvedValue(HEROES),
      findUnique: jest.fn(({ where }) => Promise.resolve(HEROES.find((h) => h.id === where.id) ?? null)),
    },
  };
  const mlbb = {
    getHeroes: jest.fn().mockRejectedValue(new Error('offline')),
  };
  const heroMeta = {
    getHeroMeta: jest.fn().mockRejectedValue(new Error('offline')),
    getRanking: jest.fn().mockRejectedValue(new Error('offline')),
  };
  const config = { get: jest.fn((k: string) => (k === 'AI_MODEL' ? 'claude-opus-5' : undefined)) };
  const service = new AiService(
    config as unknown as ConfigService,
    prisma as unknown as PrismaService,
    mlbb as unknown as MlbbService,
    heroMeta as unknown as HeroMetaService,
    opts.client ?? null,
    new RateLimiter(AI_RATE_LIMIT, 60_000, now),
    new TtlCache(60_000, now),
  );
  return { service, prisma, mlbb, heroMeta, config };
}

describe('AiService (heuristic mode)', () => {
  it('reports heuristic status without a client', () => {
    const { service } = makeService();
    expect(service.getStatus()).toEqual({ enabled: false, model: 'claude-opus-5', mode: 'heuristic' });
  });

  it('serves all endpoints from heuristics with catalog heroes', async () => {
    const { service } = makeService();
    const coach = await service.coach('u1', 'fr');
    expect(coach.source).toBe('heuristic');
    expect(coach.heroes[0].name).toBe('Tigreal'); // favourite first
    const rec = await service.recommendHeroes('u1', 'MAGE', undefined, 'en');
    expect(rec.heroes.map((h) => h.name)).toEqual(['Kagura']);
    const build = await service.recommendBuild('u1', HEROES[2].id, 'en');
    expect(build.hero.name).toBe('Gusion');
    expect(build.metaAvailable).toBe(false);
    expect(build.spell.name).toBe('Retribution');
    const counter = await service.counterPicks('u1', [HEROES[1].id], 'fr');
    expect(counter.enemies[0].name).toBe('Layla');
    expect(counter.counters.map((c) => c.name)).not.toContain('Layla');
    expect(counter.counters.length).toBeGreaterThan(0);
    const an = await service.analyze('u1', 'en');
    expect(an.stats.games).toBe(50);
  });

  it('returns 404 for unknown heroes and users', async () => {
    const { service } = makeService();
    await expect(service.recommendBuild('u1', 'ffffffffffffffffffffffff', 'fr')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.counterPicks('u1', [HEROES[0].id, 'ffffffffffffffffffffffff'], 'fr')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.coach('missing-user', 'fr')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AiService rate limit + cache', () => {
  it('limits per user with 429, cache hits do not consume quota, other users still pass', async () => {
    let t = 1_000;
    const { service } = makeService({ now: () => t });
    // 20 distinct calls for u1 (different endpoints/langs/inputs) consume the quota.
    const calls: Array<() => Promise<unknown>> = [];
    for (const lang of ['fr', 'en'] as const) {
      calls.push(() => service.coach('u1', lang), () => service.analyze('u1', lang));
      for (const h of HEROES) calls.push(() => service.recommendBuild('u1', h.id, lang));
      for (const role of ['tank', 'mage']) calls.push(() => service.recommendHeroes('u1', role, undefined, lang));
    }
    expect(calls.length).toBe(AI_RATE_LIMIT);
    for (const c of calls) await c();
    // Identical request: served from cache, no quota consumed, no error.
    await expect(service.recommendHeroes('u1', 'tank', undefined, 'en')).resolves.toBeTruthy();
    // New (uncached) request for u1: 429.
    let err: unknown;
    try {
      await service.recommendHeroes('u1', 'support', undefined, 'fr');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ statusCode: 429, retryAfter: expect.any(Number) });
    // Another user is unaffected.
    await expect(service.coach('u2', 'fr')).resolves.toMatchObject({ source: 'heuristic' });
    // After the window, u1 passes again (cache expired too).
    t += 60_001;
    await expect(service.recommendHeroes('u1', 'support', undefined, 'fr')).resolves.toMatchObject({ source: 'heuristic' });
  });

  it('caches per input hash for one hour', async () => {
    let t = 0;
    const { service, prisma } = makeService({ now: () => t });
    await service.analyze('u1', 'fr');
    await service.analyze('u1', 'fr');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    await service.analyze('u1', 'en'); // different input -> recomputed
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
    t = 60_001;
    await service.analyze('u1', 'fr'); // expired
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
  });
});

describe('AiService (LLM mode, mocked Anthropic client)', () => {
  it('uses forced tool use, validates names against the catalog and drops unknown heroes', async () => {
    const create = jest.fn().mockResolvedValue(
      toolMessage(TOOLS.counter.name, {
        counters: [
          { name: 'gusion', reason: 'Dive her', effectiveness: 0.9, against: ['Layla'] },
          { name: 'Made Up Hero', reason: 'nope', effectiveness: 1, against: ['Layla'] },
          { name: 'Layla', reason: 'self', effectiveness: 1, against: [] },
        ],
      }),
    );
    const { service } = makeService({ client: { messages: { create } } });
    expect(service.getStatus()).toMatchObject({ enabled: true, mode: 'llm' });

    const res = await service.counterPicks('u1', [HEROES[1].id], 'en');
    expect(res.source).toBe('llm');
    expect(res.counters.map((c) => c.name)).toEqual(['Gusion']);
    expect(res.counters[0].id).toBe(HEROES[2].id);
    expect(res.counters[0].image).toBe('Gusion.png');

    expect(create).toHaveBeenCalledTimes(1);
    const req = create.mock.calls[0][0];
    expect(req.model).toBe('claude-opus-5');
    expect(req.tool_choice).toEqual({ type: 'tool', name: TOOLS.counter.name });
    expect(req.tools[0].strict).toBe(true);
    expect(req.system).toContain('Tigreal [tank; lanes: roam]');
    expect(req.system).toContain('English');
    expect(req.messages[0].content).toContain('ENEMY PICKS: Layla [marksman]');
  });

  it('falls back to the heuristic when the API fails or returns invalid output', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(toolMessage(TOOLS.coach.name, { summary: 'x', tips: [], heroes: [] }))
      .mockResolvedValueOnce({ ...toolMessage('other_tool', {}), stop_reason: 'end_turn' });
    const { service } = makeService({ client: { messages: { create } } });
    expect((await service.coach('u1', 'fr')).source).toBe('heuristic');
    expect((await service.coach('u1', 'en')).source).toBe('heuristic');
    expect((await service.analyze('u1', 'fr')).source).toBe('heuristic');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('validates build output (emblem/spell shapes) and hero recommendations', async () => {
    const create = jest
      .fn()
      .mockResolvedValueOnce(
        toolMessage(TOOLS.build.name, {
          note: 'meta missing',
          boots: { name: 'Magic Shoes', reason: 'cdr' },
          items: [
            { name: 'Hunter Strike', reason: 'a', priority: 'core' },
            { name: 'Blade of Despair', reason: 'b', priority: 'core' },
            { name: 'Malefic Roar', reason: 'c', priority: 'situational' },
          ],
          emblem: { name: 'Emblem of Nonsense', talents: [], reason: '' },
          spell: { name: 'Retribution', reason: 'jungle' },
        }),
      )
      .mockResolvedValueOnce(
        toolMessage(TOOLS.recommend.name, {
          heroes: [
            { name: 'Kagura', reason: 'k', confidence: 0.8 },
            { name: 'Nobody', reason: 'n', confidence: 0.8 },
          ],
        }),
      );
    const { service } = makeService({ client: { messages: { create } } });
    const build = await service.recommendBuild('u1', HEROES[2].id, 'fr');
    expect(build.source).toBe('llm');
    expect(build.emblem.name).toBe('Assassin Emblem'); // invalid emblem replaced by class default
    expect(build.spell.name).toBe('Retribution');
    expect(build.items).toHaveLength(3);

    const rec = await service.recommendHeroes('u1', 'mage', undefined, 'fr');
    expect(rec.source).toBe('llm');
    expect(rec.heroes.map((h) => h.name)).toEqual(['Kagura']);
    // Only the filtered pool is listed in the system prompt.
    expect(create.mock.calls[1][0].system).toContain('Kagura [mage');
    expect(create.mock.calls[1][0].system).not.toContain('Layla [marksman');
  });
});
