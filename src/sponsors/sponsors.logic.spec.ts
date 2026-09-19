import { BadRequestException } from '@nestjs/common';
import {
  RateLimiter,
  cleanBenefits,
  clientIp,
  filterForSeason,
  groupByTier,
  normalizeSponsorInput,
  parseBenefits,
  serializeOffer,
  serializeSponsor,
  sortOffers,
} from './sponsors.logic';

const S1 = '111111111111111111111111';
const S2 = '222222222222222222222222';

const sponsor = (over: Partial<Parameters<typeof serializeSponsor>[0]> = {}) => ({
  id: 'a',
  name: 'Acme',
  logo: 'https://x/logo.png',
  url: null,
  sort: 0,
  ...over,
});

describe('sponsor serialization', () => {
  it('gives legacy rows a default tier, no seasons and an active flag', () => {
    const s = serializeSponsor(sponsor());
    expect(s.tier).toBe('partner');
    expect(s.seasonIds).toEqual([]);
    expect(s.isActive).toBe(true);
    expect(s.website).toBeNull();
  });

  it('exposes url as website too', () => {
    expect(serializeSponsor(sponsor({ url: 'https://acme.tg' })).website).toBe('https://acme.tg');
  });
});

describe('season filtering and tiers', () => {
  const rows = [
    sponsor({ id: 'global', tier: 'silver', sort: 2 }),
    sponsor({ id: 's1', tier: 'title', seasonIds: [S1] }),
    sponsor({ id: 's2', tier: 'gold', seasonIds: [S2] }),
    sponsor({ id: 'off', tier: 'title', isActive: false }),
    sponsor({ id: 'both', tier: 'silver', sort: 1, seasonIds: [S1, S2] }),
  ];

  it('keeps active sponsors of the season plus season-less ones, tier first', () => {
    const ids = filterForSeason(rows, S1).map((s) => s.id);
    expect(ids).toEqual(['s1', 'both', 'global']);
  });

  it('returns every active sponsor without a season', () => {
    const ids = filterForSeason(rows, null).map((s) => s.id);
    expect(ids).toEqual(['s1', 's2', 'both', 'global']);
    expect(ids).not.toContain('off');
  });

  it('groups by tier with every tier present', () => {
    const grouped = groupByTier(filterForSeason(rows, S2));
    expect(Object.keys(grouped)).toEqual(['title', 'gold', 'silver', 'partner']);
    expect(grouped.gold.map((s) => s.id)).toEqual(['s2']);
    expect(grouped.partner).toEqual([]);
  });
});

describe('normalizeSponsorInput', () => {
  it('requires a logo on create but not on patch', () => {
    expect(() => normalizeSponsorInput({ name: 'x' }, false)).toThrow(BadRequestException);
    expect(normalizeSponsorInput({ name: 'x' }, true)).toEqual({ name: 'x' });
  });

  it('validates tier and season ids, accepts website as url alias', () => {
    const out = normalizeSponsorInput(
      { logo: ' l ', tier: 'gold', seasonIds: [S1, S1], website: 'https://a', isActive: 'true', sort: '3' },
      false,
    );
    expect(out).toEqual({ logo: 'l', tier: 'gold', seasonIds: [S1], url: 'https://a', isActive: true, sort: 3 });
    expect(() => normalizeSponsorInput({ logo: 'l', tier: 'platinum' }, false)).toThrow(BadRequestException);
    expect(() => normalizeSponsorInput({ logo: 'l', seasonIds: ['nope'] }, false)).toThrow(BadRequestException);
    expect(() => normalizeSponsorInput({ logo: 'l', seasonIds: 'x' }, false)).toThrow(BadRequestException);
    expect(normalizeSponsorInput({ tier: '' }, true)).toEqual({ tier: null });
  });
});

describe('offers', () => {
  it('parses benefits defensively', () => {
    expect(parseBenefits(null)).toEqual([]);
    expect(parseBenefits('nope')).toEqual([]);
    expect(parseBenefits('["a", 1, "b"]')).toEqual(['a', 'b']);
  });

  it('serializes and sorts, hiding inactive ones by default', () => {
    const offers = [
      serializeOffer({ id: '1', name: 'B', benefits: '[]', highlight: false, sort: 1 }),
      serializeOffer({ id: '2', name: 'A', benefits: '["x"]', highlight: true, sort: 1, isActive: false }),
      serializeOffer({ id: '3', name: 'C', benefits: '[]', highlight: false, sort: 0, tier: 'gold' }),
    ];
    expect(sortOffers(offers).map((o) => o.id)).toEqual(['3', '1']);
    expect(sortOffers(offers, true).map((o) => o.id)).toEqual(['3', '2', '1']);
    expect(offers[2].tier).toBe('gold');
    expect(offers[0].tier).toBeNull();
  });
});

describe('RateLimiter', () => {
  it('allows `max` hits per window then blocks until the window slides', () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit('ip', 0)).toBe(true);
    expect(rl.hit('ip', 10)).toBe(true);
    expect(rl.hit('ip', 20)).toBe(false);
    expect(rl.hit('other', 20)).toBe(true);
    expect(rl.hit('ip', 1011)).toBe(true);
  });
});

describe('clientIp', () => {
  it('prefers the first forwarded address', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, ip: '9.9.9.9' })).toBe('1.2.3.4');
    expect(clientIp({ headers: {}, ip: '9.9.9.9' })).toBe('9.9.9.9');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '::1' } })).toBe('::1');
    expect(clientIp({})).toBe('unknown');
  });
});

describe('cleanBenefits', () => {
  it('trims, drops empty lines and duplicates', () => {
    expect(cleanBenefits([' Logo ', '', 'Logo', 'Mentions'])).toEqual(['Logo', 'Mentions']);
    expect(cleanBenefits(undefined)).toEqual([]);
  });
});
