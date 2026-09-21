import { normalizeLane, normalizeRank } from './gms.constants';

describe('gms.constants normalizers', () => {
  it('maps known ranks by key or GMS value', () => {
    expect(normalizeRank('Mythic')).toBe('mythic');
    expect(normalizeRank('7')).toBe('mythic');
    expect(normalizeRank('')).toBe('all');
    expect(normalizeRank('bogus')).toBe('all');
  });

  it('rejects inherited object keys', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(normalizeRank(k)).toBe('all');
      expect(normalizeLane(k)).toBeNull();
    }
  });

  it('maps known lanes by key or id', () => {
    expect(normalizeLane('GOLD')).toBe('gold');
    expect(normalizeLane('5')).toBe('gold');
    expect(normalizeLane('9')).toBeNull();
  });
});
