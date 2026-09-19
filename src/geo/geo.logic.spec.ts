import { OTHER_CITY_ID, TOGO_CITIES, cityKey, normalizeCity } from './geo.constants';
import { aggregateMap, inSeasonWindow, isProfilePublic, isUpcoming } from './geo.logic';

describe('normalizeCity', () => {
  it('matches canonical names regardless of case and accents', () => {
    expect(normalizeCity('Lomé')?.id).toBe('lome');
    expect(normalizeCity('LOME')?.id).toBe('lome');
    expect(normalizeCity('  lome ')?.id).toBe('lome');
    expect(normalizeCity('Kpalime')?.id).toBe('kpalime');
    expect(normalizeCity('SOKODÉ')?.id).toBe('sokode');
    expect(normalizeCity('Guerin Kouka')?.id).toBe('guerin-kouka');
  });

  it('matches aliases and neighbourhoods', () => {
    expect(normalizeCity('Agoè-Nyivé')?.id).toBe('lome');
    expect(normalizeCity('Baguida')?.id).toBe('lome');
    expect(normalizeCity('Palimé')?.id).toBe('kpalime');
    expect(normalizeCity('Sansanné-Mango')?.id).toBe('mango');
    expect(normalizeCity('Lama-Kara')?.id).toBe('kara');
  });

  it('accepts a trailing country', () => {
    expect(normalizeCity('Kara, Togo')?.id).toBe('kara');
    expect(normalizeCity('Dapaong (Togo)')?.id).toBe('dapaong');
  });

  it('returns null for empty, "Autre" and unknown values', () => {
    expect(normalizeCity(undefined)).toBeNull();
    expect(normalizeCity('')).toBeNull();
    expect(normalizeCity('Autre')).toBeNull();
    expect(normalizeCity('other')).toBeNull();
    expect(normalizeCity('Paris')).toBeNull();
    expect(normalizeCity('Accra')).toBeNull();
  });

  it('has unique ids and keys in the gazetteer', () => {
    const ids = TOGO_CITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOGO_CITIES.length).toBeGreaterThanOrEqual(30);
    for (const c of TOGO_CITIES) {
      expect(c.lat).toBeGreaterThan(6);
      expect(c.lat).toBeLessThan(11.2);
      expect(c.lng).toBeGreaterThan(-0.2);
      expect(c.lng).toBeLessThan(1.9);
    }
  });

  it('cityKey strips punctuation', () => {
    expect(cityKey("Agoè-Nyivé (Lomé)")).toBe('agoe nyive lome');
  });
});

describe('isProfilePublic', () => {
  it('defaults to public', () => {
    expect(isProfilePublic(null)).toBe(true);
    expect(isProfilePublic({})).toBe(true);
    expect(isProfilePublic({ showStats: false })).toBe(true);
  });
  it('honours profilePublic=false', () => {
    expect(isProfilePublic({ profilePublic: false })).toBe(false);
  });
});

describe('isUpcoming / inSeasonWindow', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('uses the status first', () => {
    expect(isUpcoming({ status: 'completed', startDate: '2099-01-01' }, now)).toBe(false);
    expect(isUpcoming({ status: 'ongoing', startDate: '2000-01-01' }, now)).toBe(true);
  });

  it('falls back to the dates (end of day inclusive)', () => {
    expect(isUpcoming({ startDate: '2026-06-15' }, now)).toBe(true);
    expect(isUpcoming({ startDate: '2026-06-10', endDate: '2026-06-20' }, now)).toBe(true);
    expect(isUpcoming({ startDate: '2026-06-01', endDate: '2026-06-10' }, now)).toBe(false);
    expect(isUpcoming({ date: '2026-07-01' }, now)).toBe(true);
    expect(isUpcoming({ date: '2026-01-01' }, now)).toBe(false);
  });

  it('keeps undated items only when flagged upcoming', () => {
    expect(isUpcoming({ status: 'upcoming' }, now)).toBe(true);
    expect(isUpcoming({}, now)).toBe(false);
  });

  it('filters by the season window', () => {
    const season = { id: 's', name: 'S1', startDate: '2026-01-01', endDate: '2026-06-30' };
    expect(inSeasonWindow('2026-03-01', season)).toBe(true);
    expect(inSeasonWindow('2026-06-30', season)).toBe(true);
    expect(inSeasonWindow('2026-07-02', season)).toBe(false);
    expect(inSeasonWindow('2025-12-31', season)).toBe(false);
    expect(inSeasonWindow(null, season)).toBe(true);
    expect(inSeasonWindow('2030-01-01', null)).toBe(true);
    expect(inSeasonWindow('2030-01-01', { id: 's', name: 'open' })).toBe(true);
  });
});

describe('aggregateMap', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  const base = () => ({
    users: [
      { id: 'u1', username: 'alpha', city: 'Lomé', privacy: null },
      { id: 'u2', username: 'bravo', city: 'lome', privacy: { profilePublic: false } },
      { id: 'u3', username: 'charlie', city: 'Agoè', privacy: {} },
      { id: 'u4', username: 'delta', city: 'Lome', privacy: {} },
      { id: 'u5', username: 'echo', city: 'LOMÉ', privacy: {} },
      { id: 'u6', username: 'fox', city: 'Kara', privacy: {} },
      { id: 'u7', username: 'golf', city: 'Paris', privacy: {} },
      { id: 'u8', username: 'hotel', city: null, privacy: {} },
      { id: 'u9', username: 'india', city: 'Autre', privacy: {} },
    ],
    teams: [
      { id: 't1', name: 'Lions', city: 'Lomé', type: 'esport', memberCount: 5 },
      { id: 't2', name: 'Eagles', city: 'Kara', type: 'community', memberCount: 3 },
      { id: 't3', name: 'Nomads', city: 'Mars' },
      { id: 't4', name: 'Ghosts', city: null },
    ],
    tournaments: [
      { id: 'tr1', name: 'Cup', city: 'Lomé', status: 'upcoming', startDate: '2026-07-01' },
      { id: 'tr2', name: 'Old Cup', city: 'Lomé', status: 'completed', startDate: '2026-02-01' },
      { id: 'tr3', name: 'North', city: 'Kara', status: 'upcoming', startDate: '2025-01-01' },
    ],
    events: [
      { id: 'e1', title: 'Scrim', city: 'Sokodé', date: '2026-06-20' },
      { id: 'e2', title: 'Past', city: 'Sokodé', date: '2026-01-20' },
    ],
    drafts: [{ id: 'd1', name: 'Draft 5v5', city: 'Lomé', status: 'registration', category: '5v5' }],
    now,
  });

  it('counts players per normalized city and exposes at most 3 public names', () => {
    const res = aggregateMap(base());
    const lome = res.cities.find((c) => c.id === 'lome')!;
    expect(lome.players).toBe(5);
    expect(lome.topPlayers.map((p) => p.username)).toEqual(['alpha', 'charlie', 'delta']);
    expect(lome.topPlayers.some((p) => p.username === 'bravo')).toBe(false);
    const kara = res.cities.find((c) => c.id === 'kara')!;
    expect(kara.players).toBe(1);
  });

  it('buckets unknown cities under "Autre" and ignores missing ones', () => {
    const res = aggregateMap(base());
    expect(res.other.id).toBe(OTHER_CITY_ID);
    // "Paris" and an explicit "Autre" both land in the "Autre" bucket.
    expect(res.other.players).toBe(2);
    expect(res.other.teams.map((t) => t.id)).toEqual(['t3']);
    expect(res.totals.players).toBe(8);
    expect(res.totals.teams).toBe(3);
    expect(res.totals.unlocated).toBe(3);
  });

  it('separates upcoming and past tournaments / events', () => {
    const res = aggregateMap(base());
    const lome = res.cities.find((c) => c.id === 'lome')!;
    expect(lome.counts.tournaments).toBe(2);
    expect(lome.counts.upcoming).toBe(1);
    expect(lome.counts.past).toBe(1);
    expect(lome.counts.drafts).toBe(1);
    expect(lome.counts.total).toBe(5 + 1 + 2 + 0 + 1);
    const sokode = res.cities.find((c) => c.id === 'sokode')!;
    expect(sokode.counts.events).toBe(2);
    expect(sokode.counts.upcoming).toBe(1);
    // Most recent first.
    expect(sokode.events[0].id).toBe('e1');
  });

  it('restricts tournaments and events to the season window, not players', () => {
    const res = aggregateMap({
      ...base(),
      season: { id: 's1', name: 'Season 1', startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    expect(res.season).toEqual({ id: 's1', name: 'Season 1' });
    const kara = res.cities.find((c) => c.id === 'kara')!;
    expect(kara.counts.tournaments).toBe(0);
    expect(kara.players).toBe(1);
    const lome = res.cities.find((c) => c.id === 'lome')!;
    expect(lome.counts.tournaments).toBe(2);
    expect(res.totals.tournaments).toBe(2);
  });

  it('returns every gazetteer city, empty ones included', () => {
    const res = aggregateMap({ users: [], teams: [], tournaments: [], events: [], drafts: [] });
    expect(res.cities.length).toBe(TOGO_CITIES.length);
    expect(res.cities.every((c) => c.counts.total === 0)).toBe(true);
    expect(res.totals.located).toBe(0);
  });
});
