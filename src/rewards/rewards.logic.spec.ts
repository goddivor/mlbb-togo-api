import {
  checkEquip,
  closeHistory,
  electMonthlyNumberOne,
  electWeeklyMvp,
  isFrameRowActive,
  missingLevelFrames,
  nextEquipState,
  planGrant,
  previousMonth,
  previousWeek,
  resolveEquippedFrame,
  weekWindow,
} from './rewards.logic';
import {
  FRAMES,
  TITLES,
  badgeTierFor,
  frameKey,
  framesForAchievement,
  isTitleUnlocked,
  levelFramesUpTo,
  parseFrameKey,
} from './frames.catalog';
import { isCronAuthorized, runMediaStep } from './rewards-cron.controller';

const DAY = 86_400_000;
const d = (s: string) => new Date(s);

describe('frames catalogue', () => {
  it('has the 64 frames of the preview: 39 circles, 25 squares, unique ids', () => {
    expect(FRAMES).toHaveLength(64);
    expect(new Set(FRAMES.map((f) => f.id)).size).toBe(64);
    expect(FRAMES.filter((f) => f.shape === 'circle')).toHaveLength(39);
    expect(FRAMES.filter((f) => f.shape === 'square')).toHaveLength(25);
  });

  it('has 25 level frames and the 5 temporary frames with their durations', () => {
    expect(FRAMES.filter((f) => f.source === 'level')).toHaveLength(25);
    const tmp = Object.fromEntries(FRAMES.filter((f) => f.expiry).map((f) => [f.id, f.expiry]));
    expect(tmp).toEqual({
      champion_en_titre: { until: 'next_champion' },
      mvp_semaine: { days: 7 },
      numero_un: { days: 30 },
      coupe_independance: { days: 30 },
      lanternes: { days: 14 },
    });
  });

  it('maps achievements to frames', () => {
    expect(framesForAchievement('tournament_winner').map((f) => f.id)).toEqual(['lauriers_tournoi']);
    expect(framesForAchievement('tournament_mvp').map((f) => f.id)).toEqual(['couronne_imperiale']);
    expect(framesForAchievement('first_win')).toEqual([]);
  });

  it('lists level frames up to a level (catch-up)', () => {
    expect(levelFramesUpTo(1).map((f) => f.id)).toEqual(['recrue']);
    expect(levelFramesUpTo(25).map((f) => f.id).sort()).toEqual(
      ['argent_filigrane', 'argent_lames', 'bronze_forge', 'ecu_bronze', 'recrue'].sort(),
    );
    expect(levelFramesUpTo(200)).toHaveLength(25);
  });

  it('parses frame keys with variants', () => {
    expect(frameKey('champion_saison', 'S2')).toBe('champion_saison:S2');
    expect(frameKey('recrue', '')).toBe('recrue');
    expect(parseFrameKey('champion_saison:S2')).toEqual({ frameId: 'champion_saison', variant: 'S2' });
    expect(parseFrameKey('recrue')).toEqual({ frameId: 'recrue', variant: '' });
  });

  it('unlocks titles by level and maps badge tiers', () => {
    expect(TITLES).toHaveLength(17);
    expect(isTitleUnlocked('aspirant', 4)).toBe(false);
    expect(isTitleUnlocked('aspirant', 5)).toBe(true);
    expect(isTitleUnlocked('nope', 200)).toBe(false);
    expect(badgeTierFor(1)).toBe('bronze');
    expect(badgeTierFor(20)).toBe('argent');
    expect(badgeTierFor(129)).toBe('epique');
    expect(badgeTierFor(200)).toBe('mythe');
  });
});

describe('planGrant', () => {
  const now = d('2026-09-21T10:00:00Z');

  it('creates a permanent or temporary row', () => {
    expect(planGrant(null, {}, now)).toEqual({
      action: 'create',
      expiresAt: null,
      history: [{ from: now.toISOString(), to: null }],
    });
    const tmp = planGrant(null, { days: 7 }, now);
    expect(tmp.action).toBe('create');
    expect((tmp as any).expiresAt).toEqual(new Date(now.getTime() + 7 * DAY));
  });

  it('is a no-op for an owned permanent frame (add-only)', () => {
    const row = { expiresAt: null, expiredAt: null, timesGranted: 1, history: [] };
    expect(planGrant(row, {}, now)).toEqual({ action: 'noop' });
    expect(planGrant(row, { days: 7 }, now)).toEqual({ action: 'noop' });
  });

  it('extends an active temporary frame from its expiry', () => {
    const expiresAt = d('2026-09-25T00:00:00Z');
    const plan = planGrant(
      { expiresAt, expiredAt: null, timesGranted: 1, history: [{ from: '2026-09-18T00:00:00.000Z', to: expiresAt.toISOString() }] },
      { days: 7 },
      now,
    ) as any;
    expect(plan.kind).toBe('extend');
    expect(plan.expiresAt).toEqual(new Date(expiresAt.getTime() + 7 * DAY));
    expect(plan.history).toHaveLength(1);
    expect(plan.timesGranted).toBe(2);
  });

  it('reactivates an expired frame with a new period', () => {
    const plan = planGrant(
      {
        expiresAt: d('2026-08-01T00:00:00Z'),
        expiredAt: d('2026-08-01T00:00:00Z'),
        timesGranted: 1,
        history: [{ from: '2026-07-25T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }],
      },
      { days: 14 },
      now,
    ) as any;
    expect(plan.kind).toBe('reactivate');
    expect(plan.history).toHaveLength(2);
    expect(plan.expiresAt).toEqual(new Date(now.getTime() + 14 * DAY));
  });

  it('continues a consecutive re-election within the grace window', () => {
    const monday = d('2026-09-21T00:00:00Z');
    const plan = planGrant(
      {
        expiresAt: monday,
        expiredAt: monday,
        timesGranted: 1,
        history: [{ from: '2026-09-14T00:00:00.000Z', to: monday.toISOString() }],
      },
      { days: 7, startsAt: monday, continuityGraceMs: 3 * DAY },
      d('2026-09-21T00:05:00Z'),
    ) as any;
    expect(plan.kind).toBe('extend');
    expect(plan.expiresAt).toEqual(d('2026-09-28T00:00:00Z'));
    expect(plan.history).toEqual([{ from: '2026-09-14T00:00:00.000Z', to: '2026-09-28T00:00:00.000Z' }]);
  });

  it('does not bridge the grace window over a frame an admin ended early', () => {
    const monday = d('2026-09-21T00:00:00Z');
    const endedAt = d('2026-09-20T18:00:00Z');
    const plan = planGrant(
      {
        expiresAt: endedAt,
        expiredAt: endedAt,
        timesGranted: 1,
        history: closeHistory([{ from: '2026-09-14T00:00:00.000Z', to: monday.toISOString() }], endedAt, true),
      },
      { days: 7, startsAt: monday, continuityGraceMs: 3 * DAY },
      d('2026-09-21T00:05:00Z'),
    ) as any;
    expect(plan.kind).toBe('reactivate');
    expect(plan.expiresAt).toEqual(d('2026-09-28T00:00:00Z'));
    expect(plan.history).toEqual([
      { from: '2026-09-14T00:00:00.000Z', to: endedAt.toISOString(), endedEarly: true },
      { from: monday.toISOString(), to: '2026-09-28T00:00:00.000Z' },
    ]);
  });

  it('marks early ends in the history only when asked', () => {
    const h = [{ from: '2026-09-14T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z' }];
    expect(closeHistory(h, d('2026-09-18T00:00:00Z'))[0]).not.toHaveProperty('endedEarly');
    expect(closeHistory(h, d('2026-09-18T00:00:00Z'), true)[0]).toMatchObject({ endedEarly: true });
  });

  it('turns a temporary frame permanent on a permanent grant', () => {
    const plan = planGrant(
      { expiresAt: d('2026-10-01T00:00:00Z'), expiredAt: null, timesGranted: 1, history: [{ from: 'x', to: 'y' }] },
      {},
      now,
    ) as any;
    expect(plan.kind).toBe('make_permanent');
    expect(plan.expiresAt).toBeNull();
    expect(plan.history[0].to).toBeNull();
  });
});

describe('expiry', () => {
  const now = d('2026-09-21T10:00:00Z');

  it('a row is active until its expiry or an explicit end', () => {
    expect(isFrameRowActive({ expiresAt: null, expiredAt: null }, now)).toBe(true);
    expect(isFrameRowActive({ expiresAt: d('2026-09-22T00:00:00Z'), expiredAt: null }, now)).toBe(true);
    expect(isFrameRowActive({ expiresAt: d('2026-09-21T10:00:00Z'), expiredAt: null }, now)).toBe(false);
    expect(isFrameRowActive({ expiresAt: null, expiredAt: d('2026-09-20T00:00:00Z') }, now)).toBe(false);
    expect(isFrameRowActive(null, now)).toBe(false);
  });

  it('closes the open period of the history', () => {
    expect(closeHistory([{ from: 'a', to: null }], now)).toEqual([{ from: 'a', to: now.toISOString() }]);
    expect(closeHistory([{ from: 'a', to: '2026-12-01T00:00:00.000Z' }], now)[0].to).toBe(now.toISOString());
    expect(closeHistory([{ from: 'a', to: '2026-01-01T00:00:00.000Z' }], now)[0].to).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('equip rules and fallback', () => {
  const now = d('2026-09-21T10:00:00Z');

  it('rejects unknown, unowned and expired frames', () => {
    expect(checkEquip(false, null, now)).toBe('unknown_frame');
    expect(checkEquip(true, null, now)).toBe('not_owned');
    expect(checkEquip(true, { expiresAt: d('2026-09-01T00:00:00Z'), expiredAt: null }, now)).toBe('expired');
    expect(checkEquip(true, { expiresAt: null, expiredAt: null }, now)).toBe('ok');
  });

  it('records permanent frames as fallback, keeps it for temporary ones, clears it for none', () => {
    const exp = d('2026-09-28T00:00:00Z');
    expect(nextEquipState({}, 'or_couronne', false, null)).toEqual({
      equippedFrame: 'or_couronne',
      fallbackFrame: 'or_couronne',
      equippedFrameExpiresAt: null,
    });
    expect(nextEquipState({ fallbackFrame: 'or_couronne' }, 'mvp_semaine', true, exp)).toEqual({
      equippedFrame: 'mvp_semaine',
      fallbackFrame: 'or_couronne',
      equippedFrameExpiresAt: exp,
    });
    expect(nextEquipState({ fallbackFrame: 'or_couronne' }, null, false, null)).toEqual({
      equippedFrame: null,
      fallbackFrame: null,
      equippedFrameExpiresAt: null,
    });
  });

  it('resolves an expired equipped frame to the fallback, else none', () => {
    const past = d('2026-09-21T00:00:00Z');
    const future = d('2026-09-28T00:00:00Z');
    expect(resolveEquippedFrame(null, now)).toBeNull();
    expect(resolveEquippedFrame({ equippedFrame: 'recrue' }, now)).toBe('recrue');
    expect(resolveEquippedFrame({ equippedFrame: 'mvp_semaine', equippedFrameExpiresAt: future }, now)).toBe('mvp_semaine');
    expect(
      resolveEquippedFrame({ equippedFrame: 'mvp_semaine', fallbackFrame: 'recrue', equippedFrameExpiresAt: past }, now),
    ).toBe('recrue');
    expect(resolveEquippedFrame({ equippedFrame: 'mvp_semaine', equippedFrameExpiresAt: past.toISOString() }, now)).toBeNull();
  });
});

describe('elections', () => {
  const t = (s: string) => d(`2026-09-${s}Z`);

  it('elects nobody without an official match that week', () => {
    expect(electWeeklyMvp([{ userId: 'a', mvps: 2, wins: 1, firstMvpAt: t('15T10:00:00') }], 0)).toBeNull();
    expect(electWeeklyMvp([], 3)).toBeNull();
  });

  it('elects the most MVPs, then most wins, then earliest MVP', () => {
    expect(
      electWeeklyMvp(
        [
          { userId: 'a', mvps: 1, wins: 5, firstMvpAt: t('14T10:00:00') },
          { userId: 'b', mvps: 2, wins: 0, firstMvpAt: t('16T10:00:00') },
        ],
        4,
      ),
    ).toBe('b');
    expect(
      electWeeklyMvp(
        [
          { userId: 'a', mvps: 2, wins: 1, firstMvpAt: t('14T10:00:00') },
          { userId: 'b', mvps: 2, wins: 3, firstMvpAt: t('16T10:00:00') },
        ],
        4,
      ),
    ).toBe('b');
    expect(
      electWeeklyMvp(
        [
          { userId: 'a', mvps: 2, wins: 3, firstMvpAt: t('16T10:00:00') },
          { userId: 'b', mvps: 2, wins: 3, firstMvpAt: t('14T10:00:00') },
        ],
        4,
      ),
    ).toBe('b');
  });

  it('elects the monthly number one by XP, ties to who reached it first', () => {
    expect(electMonthlyNumberOne([])).toBeNull();
    expect(electMonthlyNumberOne([{ userId: 'a', xp: 0, lastAt: t('01T00:00:00') }])).toBeNull();
    expect(
      electMonthlyNumberOne([
        { userId: 'a', xp: 500, lastAt: t('20T00:00:00') },
        { userId: 'b', xp: 500, lastAt: t('10T00:00:00') },
        { userId: 'c', xp: 300, lastAt: t('01T00:00:00') },
      ]),
    ).toBe('b');
  });

  it('computes the previous week and month windows (UTC)', () => {
    const w = previousWeek(d('2026-09-23T12:00:00Z')); // Wednesday
    expect(w.start).toEqual(d('2026-09-14T00:00:00Z'));
    expect(w.end).toEqual(d('2026-09-21T00:00:00Z'));
    expect(w.key).toBe('2026-W38');
    expect(weekWindow('2026-W38')).toEqual(w);
    expect(weekWindow('2026-W99')).toBeNull();
    const m = previousMonth(d('2026-01-01T00:05:00Z'));
    expect(m).toEqual({ start: d('2025-12-01T00:00:00Z'), end: d('2026-01-01T00:00:00Z'), key: '2025-12' });
  });
});

describe('level catch-up', () => {
  it('returns the level frames not owned yet', () => {
    const due = levelFramesUpTo(30).map((f) => f.id);
    expect(missingLevelFrames(due, ['recrue', 'ecu_bronze'])).toEqual(
      due.filter((id) => id !== 'recrue' && id !== 'ecu_bronze'),
    );
    expect(missingLevelFrames(due, due)).toEqual([]);
  });
});

describe('cron authorization', () => {
  it('requires the exact bearer secret', () => {
    expect(isCronAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    expect(isCronAuthorized('Bearer wrong!', 's3cret')).toBe(false);
    expect(isCronAuthorized(undefined, 's3cret')).toBe(false);
    expect(isCronAuthorized('Bearer ', undefined)).toBe(false);
  });

  it('runs the media maintenance with a time budget and never fails the daily job', async () => {
    const now = new Date('2026-09-22T03:00:00Z');
    const report = { abandoned: { found: 1, deleted: 1, failed: 0, skipped: 0 }, linked: { found: 0, linked: 0 } };
    const media = { runMaintenance: jest.fn(async () => report) };
    expect(await runMediaStep(media as any, now, 5000)).toBe(report);
    expect(media.runMaintenance).toHaveBeenCalledWith(now, { limit: 50, budgetMs: 5000 });
    media.runMaintenance.mockRejectedValueOnce(new Error('db down'));
    expect(await runMediaStep(media as any, now)).toEqual({ error: 'db down' });
  });
});

describe('avatar payloads', () => {
  // Imported lazily to keep this suite focused on pure helpers.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { serializeUserCard, serializePublicUser } = require('../users/users.service');
  const base = { id: 'u1', username: 'alice', favoriteHeroes: '[]', badges: '[]', wins: 0, losses: 0 };

  it('exposes the resolved frame and the title on cards and public profiles', () => {
    const past = new Date(Date.now() - 1000);
    const user = { ...base, equippedFrame: 'mvp_semaine', fallbackFrame: 'recrue', equippedFrameExpiresAt: past, equippedTitle: 'aspirant' };
    expect(serializeUserCard(user)).toMatchObject({ equippedFrame: 'recrue', equippedTitle: 'aspirant' });
    expect(serializePublicUser(user)).toMatchObject({ equippedFrame: 'recrue', equippedTitle: 'aspirant' });
    expect(serializeUserCard(base)).toMatchObject({ equippedFrame: null, equippedTitle: null });
  });
});
