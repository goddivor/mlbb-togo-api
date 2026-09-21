import {
  EventShape,
  addYear,
  defaultEvents,
  isEvaluating,
  isQualified,
  isWindowOpen,
  nextEditionSlug,
  nextStatus,
  parseConditions,
  parseRewards,
  refFilter,
  validateEvent,
  wideningViolations,
  withProgress,
} from './reward-events.logic';

const d = (iso: string) => new Date(iso);
const known = { achievement: (id: string) => id === 'rainy_season', frame: (id: string) => id === 'saison_pluies' };

const shape = (over: Partial<EventShape> = {}): EventShape => ({
  startsAt: d('2027-06-15T00:00:00Z'),
  endsAt: d('2027-07-15T00:00:00Z'),
  status: 'active',
  conditions: { mode: 'all', items: [{ type: 'daily_login', count: 10, scope: null }] },
  rewards: { achievementId: 'rainy_season', frameId: 'saison_pluies', frameDays: null, xp: 0 },
  ...over,
});

describe('reward events: parsing', () => {
  it('reads legacy arrays and { mode, items } objects, dropping unknown types', () => {
    expect(parseConditions([{ type: 'daily_login', count: 3 }, { type: 'hack' }])).toEqual({
      mode: 'all',
      items: [{ type: 'daily_login', count: 3, scope: null }],
    });
    expect(parseConditions({ mode: 'any', items: [{ type: 'event_joined', scope: ' e1 ' }] })).toEqual({
      mode: 'any',
      items: [{ type: 'event_joined', count: 1, scope: 'e1' }],
    });
  });

  it('keeps scopes only on scoped types and forces count 1 for account creation', () => {
    expect(parseConditions([{ type: 'daily_login', scope: 'x' }]).items[0].scope).toBeNull();
    expect(parseConditions([{ type: 'account_created_before', count: 9 }]).items[0].count).toBe(1);
  });

  it('normalises rewards', () => {
    expect(parseRewards({ frameId: 'lanternes', frameDays: '14', xp: -5 })).toEqual({
      achievementId: null,
      frameId: 'lanternes',
      frameDays: 14,
      xp: 0,
    });
  });
});

describe('reward events: validation', () => {
  it('accepts a valid event', () => {
    expect(validateEvent(shape(), known)).toEqual([]);
  });

  it('rejects inverted windows, empty conditions, missing rewards and unknown ids', () => {
    const errors = validateEvent(
      shape({
        endsAt: d('2027-06-01T00:00:00Z'),
        conditions: { mode: 'all', items: [] },
        rewards: { achievementId: 'nope', frameId: null, frameDays: null, xp: 0 },
      }),
      known,
    );
    expect(errors).toEqual(['La fin doit suivre le début.', 'Au moins une condition est requise.', 'Succès inconnu.']);
    expect(
      validateEvent(shape({ rewards: { achievementId: null, frameId: null, frameDays: null, xp: 0 } }), known),
    ).toEqual(['Au moins une récompense est requise.']);
  });

  it('requires the tournament of a bracket_played condition only once published', () => {
    const s = shape({ conditions: { mode: 'all', items: [{ type: 'bracket_played', count: 1, scope: null }] } });
    expect(validateEvent(s, known, false)).toEqual([]);
    expect(validateEvent(s, known, true)).toHaveLength(1);
  });
});

describe('reward events: window and status', () => {
  const now = d('2027-06-20T00:00:00Z');

  it('is open once published and started, evaluated until the end', () => {
    expect(isWindowOpen(shape({ status: 'draft' }), now)).toBe(false);
    expect(isWindowOpen(shape({ status: 'scheduled' }), now)).toBe(true);
    expect(isWindowOpen(shape({ status: 'scheduled' }), d('2027-06-01T00:00:00Z'))).toBe(false);
    expect(isEvaluating(shape(), d('2027-07-15T00:00:00Z'))).toBe(false);
  });

  it('moves published events through scheduled → active → closed', () => {
    expect(nextStatus(shape({ status: 'scheduled' }), d('2027-06-01T00:00:00Z'))).toBeNull();
    expect(nextStatus(shape({ status: 'scheduled' }), now)).toBe('active');
    expect(nextStatus(shape({ status: 'active' }), now)).toBeNull();
    expect(nextStatus(shape({ status: 'active' }), d('2027-07-15T00:00:00Z'))).toBe('closed');
    expect(nextStatus(shape({ status: 'draft' }), d('2028-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('reward events: widening rule for an open window', () => {
  it('accepts a later end, an earlier start, a lower count and all → any', () => {
    const prev = shape();
    const next = shape({
      startsAt: d('2027-06-10T00:00:00Z'),
      endsAt: d('2027-07-20T00:00:00Z'),
      conditions: { mode: 'any', items: [{ type: 'daily_login', count: 8, scope: null }, { type: 'event_joined', count: 1, scope: null }] },
      rewards: { ...prev.rewards, xp: 50 },
    });
    expect(wideningViolations(prev, next)).toEqual([]);
  });

  it('rejects every narrowing change', () => {
    const prev = shape({ rewards: { achievementId: 'rainy_season', frameId: 'saison_pluies', frameDays: 14, xp: 20 } });
    const next = shape({
      startsAt: d('2027-06-16T00:00:00Z'),
      endsAt: d('2027-07-14T00:00:00Z'),
      conditions: { mode: 'all', items: [{ type: 'daily_login', count: 11, scope: null }, { type: 'forum_post', count: 1, scope: null }] },
      rewards: { achievementId: null, frameId: 'lanternes', frameDays: 7, xp: 10 },
    });
    expect(wideningViolations(prev, next)).toEqual([
      'Le début ne peut pas être repoussé.',
      'La fin ne peut pas être avancée.',
      'Le seuil de « daily_login » ne peut pas augmenter.',
      'Nouvelle condition interdite : forum_post.',
      'Le succès ne peut pas changer.',
      'Le cadre ne peut pas changer.',
      'Le bonus d’XP ne peut pas baisser.',
      'La durée du cadre ne peut pas baisser.',
    ]);
  });

  it('forbids any → all and removing an alternative, allows removing a requirement', () => {
    const anyPrev = shape({
      conditions: { mode: 'any', items: [{ type: 'daily_login', count: 5, scope: null }, { type: 'event_joined', count: 1, scope: null }] },
    });
    expect(
      wideningViolations(anyPrev, shape({ conditions: { mode: 'all', items: anyPrev.conditions.items } })),
    ).toEqual(['Le mode ne peut pas passer à « toutes ».']);
    expect(
      wideningViolations(anyPrev, shape({ conditions: { mode: 'any', items: [anyPrev.conditions.items[0]] } })),
    ).toEqual(['Condition retirée interdite : event_joined.']);
    const allPrev = shape({ conditions: anyPrev.conditions && { mode: 'all', items: anyPrev.conditions.items } });
    expect(wideningViolations(allPrev, shape({ conditions: { mode: 'all', items: [allPrev.conditions.items[0]] } }))).toEqual([]);
  });

  it('forbids turning a permanent frame into a temporary one', () => {
    expect(wideningViolations(shape(), shape({ rewards: { ...shape().rewards, frameDays: 30 } }))).toEqual([
      'Un cadre permanent ne peut pas devenir temporaire.',
    ]);
  });
});

describe('reward events: progress', () => {
  it('caps progress at the target and applies the mode', () => {
    const items = [
      { type: 'daily_login' as const, count: 5, scope: null },
      { type: 'event_joined' as const, count: 1, scope: null },
    ];
    const p = withProgress(items, [7, 0]);
    expect(p.map((x) => [x.progress, x.done])).toEqual([
      [5, true],
      [0, false],
    ]);
    expect(isQualified('all', p)).toBe(false);
    expect(isQualified('any', p)).toBe(true);
    expect(isQualified('any', [])).toBe(false);
  });

  it('filters scoped conditions by tournament or event reference', () => {
    expect(refFilter({ type: 'bracket_played', count: 1, scope: 't1' })).toEqual({
      startsWith: ['bracket:t1:', 'bracket:draft:t1:'],
    });
    expect(refFilter({ type: 'tournament_registration', count: 1, scope: 't1' })).toEqual({ equals: ['t1', 'draft:t1'] });
    expect(refFilter({ type: 'daily_login', count: 1, scope: null })).toBeNull();
  });
});

describe('reward events: editions and defaults', () => {
  it('shifts dates by one year (29/02 → 28/02) and bumps the slug year', () => {
    expect(addYear(d('2028-02-29T00:00:00Z')).toISOString()).toBe('2029-02-28T00:00:00.000Z');
    expect(nextEditionSlug('rainy_season_2027', d('2027-06-15T00:00:00Z'))).toBe('rainy_season_2028');
    expect(nextEditionSlug('pioneers', d('2026-01-01T00:00:00Z'))).toBe('pioneers_2027');
  });

  it('proposes the 7 default events of catalogue §6.5 on their next window', () => {
    const now = d('2026-09-21T00:00:00Z');
    const list = defaultEvents(now, d('2026-03-10T00:00:00Z'));
    expect(list.map((e) => e.rewards.achievementId)).toEqual([
      'independence_day',
      'independence_cup',
      'rainy_season',
      'harmattan',
      'year_end_lights',
      'site_anniversary',
      'pioneer',
    ]);
    const rain = list.find((e) => e.rewards.achievementId === 'rainy_season')!;
    expect(rain.slug).toBe('rainy_season_2027');
    expect(rain.startsAt.toISOString()).toBe('2027-06-15T00:00:00.000Z');
    expect(rain.conditions.items[0]).toEqual({ type: 'daily_login', count: 10, scope: null });
    const harmattan = list.find((e) => e.rewards.achievementId === 'harmattan')!;
    expect(harmattan.slug).toBe('harmattan_2026');
    expect(harmattan.conditions.mode).toBe('any');
    const lights = list.find((e) => e.rewards.achievementId === 'year_end_lights')!;
    expect(lights.rewards.frameDays).toBe(14);
    for (const e of list) expect(validateEvent({ ...e, status: 'draft' }, { achievement: () => true, frame: () => true }, false)).toEqual([]);
  });
});
