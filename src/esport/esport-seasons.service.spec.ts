import {
  EsportSeasonsService,
  SeasonRecord,
  buildSeasonSummary,
  compareSeasons,
  nextStatus,
  parseSummary,
  resolveStatus,
  serializeSeason,
  slugify,
  uniqueSlug,
} from './esport-seasons.service';
import { MatchLike, isSeasonOver } from './esport-stats.service';
import { PrismaService } from '../prisma/prisma.service';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';

const season = (over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: '111111111111111111111111',
  name: 'Saison 3 : au-delà des limites',
  isActive: false,
  createdAt: new Date('2026-01-01'),
  ...over,
});

let seq = 0;
const done = (teamAId: string, teamBId: string, a: number, b: number, seasonId = 's'): MatchLike => ({
  id: `m${++seq}`,
  status: 'completed',
  type: 'official',
  seasonId,
  teamAId,
  teamBId,
  scoreA: a,
  scoreB: b,
  winnerTeamId: a > b ? teamAId : b > a ? teamBId : null,
  scheduledAt: new Date(Date.UTC(2026, 0, seq)),
});

describe('season pure functions', () => {
  it('slugifies names (accents, punctuation) and de-duplicates', () => {
    expect(slugify('Saison 3 : au-delà des limites')).toBe('saison-3-au-dela-des-limites');
    expect(slugify('  Été 2026 !! ')).toBe('ete-2026');
    expect(uniqueSlug('saison-3', new Set())).toBe('saison-3');
    expect(uniqueSlug('saison-3', new Set(['saison-3', 'saison-3-2']))).toBe('saison-3-3');
    expect(uniqueSlug('', new Set())).toBe('saison');
  });

  it('resolves the status of legacy rows from isActive / endDate', () => {
    const now = new Date('2026-06-01');
    expect(resolveStatus(season({ isActive: true }), now)).toBe('active');
    expect(resolveStatus(season({ endDate: new Date('2026-01-31') }), now)).toBe('closed');
    expect(resolveStatus(season({ endDate: new Date('2026-12-31') }), now)).toBe('upcoming');
    expect(resolveStatus(season(), now)).toBe('upcoming');
    // Explicit status always wins.
    expect(resolveStatus(season({ status: 'playoffs', isActive: false }), now)).toBe('playoffs');
    expect(resolveStatus(season({ status: 'closed', isActive: true }), now)).toBe('closed');
  });

  it('only allows the documented lifecycle transitions', () => {
    expect(nextStatus(season({ status: 'upcoming' }), 'activate')).toBe('active');
    expect(nextStatus(season({ status: 'upcoming' }), 'playoffs')).toBeNull();
    expect(nextStatus(season({ status: 'upcoming' }), 'close')).toBeNull();
    expect(nextStatus(season({ status: 'active' }), 'activate')).toBeNull();
    expect(nextStatus(season({ status: 'active' }), 'playoffs')).toBe('playoffs');
    expect(nextStatus(season({ status: 'active' }), 'close')).toBe('closed');
    expect(nextStatus(season({ status: 'playoffs' }), 'close')).toBe('closed');
    expect(nextStatus(season({ status: 'playoffs' }), 'reopen')).toBeNull();
    expect(nextStatus(season({ status: 'closed' }), 'reopen')).toBe('active');
    expect(nextStatus(season({ status: 'closed', playoffsStartDate: new Date() }), 'reopen')).toBe('playoffs');
    expect(nextStatus(season({ status: 'closed' }), 'activate')).toBeNull();
  });

  it('freezes standings and podium into the summary', () => {
    const teams = new Map([
      [A, { id: A, name: 'Alpha', image: null }],
      [B, { id: B, name: 'Beta', image: null }],
      [C, { id: C, name: 'Gamma', image: null }],
    ]);
    const matches: MatchLike[] = [
      done(A, B, 2, 0),
      done(B, C, 2, 1),
      done(A, C, 2, 1),
      done(C, B, 0, 2),
      { id: 'sched', status: 'scheduled', teamAId: A, teamBId: B, seasonId: 's' },
    ];
    const s = buildSeasonSummary(season({ slug: 'saison-3', number: 3 }), matches, teams, new Date('2026-07-01'));
    expect(s.version).toBe(1);
    expect(s.matches).toEqual({ total: 5, completed: 4 });
    expect(s.standings.map((r) => [r.rank, r.team.name, r.wins, r.losses])).toEqual([
      [1, 'Alpha', 2, 0],
      [2, 'Beta', 2, 1],
      [3, 'Gamma', 0, 3],
    ]);
    expect(s.podium.map((p) => p.placement)).toEqual([1, 2, 3]);
    expect(s.champion).toEqual({ teamId: A, team: { id: A, name: 'Alpha', image: null } });
    expect(s.awards).toEqual([]);
    // Round-trips through JSON (stored as a string in Mongo).
    expect(parseSummary(JSON.stringify(s))).toEqual(s);
    expect(parseSummary('{oops')).toBeNull();
    expect(parseSummary(null)).toBeNull();
  });

  it('summarises an empty season without crashing', () => {
    const s = buildSeasonSummary(season(), [], new Map());
    expect(s.standings).toEqual([]);
    expect(s.podium).toEqual([]);
    expect(s.champion).toBeNull();
  });

  it('sorts live seasons first, then by number / start date descending', () => {
    const rows = [
      season({ id: '1', number: 1, status: 'closed' }),
      season({ id: '3', number: 3, status: 'upcoming' }),
      season({ id: '2', number: 2, status: 'active' }),
      season({ id: '0', number: null, startDate: new Date('2024-01-01'), status: 'closed' }),
    ];
    expect([...rows].sort((a, b) => compareSeasons(a, b)).map((r) => r.id)).toEqual(['2', '3', '1', '0']);
  });

  it('serializes with a resolved status and keeps isActive in sync', () => {
    const out = serializeSeason(season({ status: 'playoffs', summary: '{"version":1}' }));
    expect(out).toMatchObject({ status: 'playoffs', isActive: true, summary: { version: 1 } });
    expect(serializeSeason(season({ status: 'closed', isActive: true })).isActive).toBe(false);
  });

  it('isSeasonOver honours the lifecycle status before dates', () => {
    expect(isSeasonOver({ id: 's', name: 'x', status: 'closed', endDate: new Date('2999-01-01') })).toBe(true);
    expect(isSeasonOver({ id: 's', name: 'x', status: 'active', endDate: new Date('2000-01-01') })).toBe(false);
    expect(isSeasonOver({ id: 's', name: 'x', isActive: false })).toBe(true);
  });
});

describe('EsportSeasonsService', () => {
  let rows: SeasonRecord[];
  let matches: MatchLike[];
  let prisma: any;
  let service: EsportSeasonsService;

  const teams = [
    { id: A, name: 'Alpha', image: null },
    { id: B, name: 'Beta', image: null },
  ];

  beforeEach(() => {
    rows = [
      season({ id: '111111111111111111111111', name: 'Saison 1', slug: 'saison-1', number: 1, status: 'closed', closedAt: new Date('2025-12-01') }),
      season({ id: '222222222222222222222222', name: 'Saison 2', slug: 'saison-2', number: 2, status: 'active', isActive: true }),
      // Legacy row: no slug, no status.
      season({ id: '333333333333333333333333', name: 'Saison 3', number: null }),
    ];
    matches = [];
    const select = (r: SeasonRecord, args: any) => {
      if (!args?.select) return r;
      const out: any = {};
      for (const k of Object.keys(args.select)) out[k] = (r as any)[k];
      return out;
    };
    prisma = {
      esportSeason: {
        findMany: jest.fn((args?: any) => Promise.resolve(rows.map((r) => select(r, args)))),
        findUnique: jest.fn(({ where }: any) => Promise.resolve(rows.find((r) => r.id === where.id) ?? null)),
        findFirst: jest.fn(({ where }: any) => Promise.resolve(rows.find((r) => r.slug === where.slug) ?? null)),
        create: jest.fn(({ data }: any) => {
          const created = season({ id: '444444444444444444444444', ...data });
          rows.push(created);
          return Promise.resolve(created);
        }),
        update: jest.fn(({ where, data }: any) => {
          const idx = rows.findIndex((r) => r.id === where.id);
          rows[idx] = { ...rows[idx], ...data };
          return Promise.resolve(rows[idx]);
        }),
        delete: jest.fn(() => Promise.resolve()),
      },
      esportMatch: { findMany: jest.fn(() => Promise.resolve(matches)) },
      esportTeam: { findMany: jest.fn(() => Promise.resolve(teams)) },
      seasonAward: { findMany: jest.fn(() => Promise.resolve([])) },
      user: { findMany: jest.fn(() => Promise.resolve([])) },
    };
    service = new EsportSeasonsService(prisma as unknown as PrismaService);
  });

  it('lists seasons live first, backfilling slugs of legacy rows', async () => {
    const list = await service.list();
    expect(list.map((s) => s.id)).toEqual(['222222222222222222222222', '111111111111111111111111', '333333333333333333333333']);
    expect(list[2]).toMatchObject({ slug: 'saison-3', status: 'upcoming' });
    expect(prisma.esportSeason.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: '333333333333333333333333' }, data: { slug: 'saison-3' } }),
    );
    expect((await service.list('closed')).map((s) => s.id)).toEqual(['111111111111111111111111']);
  });

  it('finds a season by id or slug and returns 404 otherwise', async () => {
    expect((await service.get('saison-2')).id).toBe('222222222222222222222222');
    expect((await service.get('111111111111111111111111')).slug).toBe('saison-1');
    await expect(service.get('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('returns the live season as current, else the latest closed one', async () => {
    expect((await service.current()).id).toBe('222222222222222222222222');
    rows[1].status = 'closed';
    rows[1].isActive = false;
    rows[1].closedAt = new Date('2026-03-01');
    expect((await service.current()).id).toBe('222222222222222222222222');
  });

  it('creates with an auto slug and number, and refuses a second live season', async () => {
    const created = await service.create({ name: 'Saison 4 : Ascension', theme: 'Ascension' });
    expect(created).toMatchObject({ slug: 'saison-4-ascension', number: 3, status: 'upcoming', isActive: false });
    await expect(service.create({ name: 'Autre', status: 'active' })).rejects.toMatchObject({ status: 409 });
    await expect(service.create({ name: 'Saison 1' })).resolves.toMatchObject({ slug: 'saison-1-2' });
  });

  it('rejects illegal transitions', async () => {
    await expect(service.activate('saison-2')).rejects.toMatchObject({ status: 409 });
    await expect(service.close('saison-1')).rejects.toMatchObject({ status: 409 });
    await expect(service.reopen('saison-2')).rejects.toMatchObject({ status: 409 });
    await expect(service.startPlayoffs('saison-1')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to activate while another season is live', async () => {
    await expect(service.activate('333333333333333333333333')).rejects.toMatchObject({ status: 409 });
  });

  it('runs the full lifecycle: playoffs -> close (frozen summary) -> reopen', async () => {
    matches = [done(A, B, 2, 1, '222222222222222222222222'), done(B, A, 0, 2, '222222222222222222222222')];

    const playoffs = await service.startPlayoffs('saison-2');
    expect(playoffs.status).toBe('playoffs');
    expect(playoffs.playoffsStartDate).toBeInstanceOf(Date);

    const preview = await service.previewSummary('saison-2');
    expect(preview.champion?.team.name).toBe('Alpha');

    const closed = await service.close('saison-2');
    expect(closed).toMatchObject({ status: 'closed', isActive: false });
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.endDate).toBeInstanceOf(Date);
    expect(closed.summary).toMatchObject({
      version: 1,
      matches: { total: 2, completed: 2 },
      champion: { teamId: A },
    });
    expect(closed.summary?.standings[0]).toMatchObject({ rank: 1, wins: 2, losses: 0 });
    // Stored as a JSON string.
    expect(typeof rows[1].summary).toBe('string');

    // Nothing is live any more: the next upcoming one can be activated.
    const activated = await service.activate('333333333333333333333333');
    expect(activated.status).toBe('active');
    // ... which blocks reopening the closed one.
    await expect(service.reopen('saison-2')).rejects.toMatchObject({ status: 409 });

    rows[2].status = 'upcoming';
    rows[2].isActive = false;
    const reopened = await service.reopen('saison-2');
    expect(reopened).toMatchObject({ status: 'playoffs', isActive: true, summary: null, closedAt: null });
  });

  it('refuses to close a season without completed matches unless forced', async () => {
    await expect(service.close('saison-2')).rejects.toMatchObject({ status: 400 });
    const closed = await service.close('saison-2', { force: true });
    expect(closed.status).toBe('closed');
    expect(closed.summary?.standings).toEqual([]);
  });

  it('updates fields and treats the legacy isActive flag as activate', async () => {
    const updated = await service.update('333333333333333333333333', {
      theme: ' Au-delà des limites ',
      slogan: '',
      color: '#ff8800',
      startDate: '2026-09-01',
      endDate: null,
    });
    expect(updated).toMatchObject({ theme: 'Au-delà des limites', slogan: null, color: '#ff8800' });
    expect(updated.startDate).toBeInstanceOf(Date);
    await expect(service.update('333333333333333333333333', { startDate: 'not-a-date' })).rejects.toMatchObject({ status: 400 });

    rows[1].status = 'closed';
    rows[1].isActive = false;
    const activated = await service.update('333333333333333333333333', { isActive: true });
    expect(activated).toMatchObject({ status: 'active', isActive: true });
  });
});
