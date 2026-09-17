import { BadRequestException } from '@nestjs/common';
import { DEFAULT_FIGURES, normalizeFiguresInput, parseFigures } from './esport-figures';

describe('esport figures', () => {
  it('falls back to defaults on empty or corrupt JSON', () => {
    expect(parseFigures(null)).toEqual(DEFAULT_FIGURES);
    expect(parseFigures('not json')).toEqual(DEFAULT_FIGURES);
    expect(parseFigures('[1,2]')).toEqual(DEFAULT_FIGURES);
  });

  it('merges stored values over the defaults and ignores invalid ones', () => {
    const parsed = parseFigures(JSON.stringify({ teams: 40, socialReach: 'x', offlineEvents: -3, extra: 1 }));
    expect(parsed).toEqual({ ...DEFAULT_FIGURES, teams: 40 });
    expect((parsed as any).extra).toBeUndefined();
  });

  it('normalizes an admin payload into a JSON string of integers', () => {
    const json = normalizeFiguresInput({ streamAudience: '12000.4', teams: 10, offlineEvents: '' });
    expect(JSON.parse(json)).toEqual({ ...DEFAULT_FIGURES, streamAudience: 12000, teams: 10 });
  });

  it('rejects non-object payloads and out-of-range values', () => {
    expect(() => normalizeFiguresInput(null)).toThrow(BadRequestException);
    expect(() => normalizeFiguresInput([1])).toThrow(BadRequestException);
    expect(() => normalizeFiguresInput({ teams: -1 })).toThrow(BadRequestException);
    expect(() => normalizeFiguresInput({ teams: 'abc' })).toThrow(BadRequestException);
    expect(() => normalizeFiguresInput({ teams: 1e12 })).toThrow(BadRequestException);
  });
});
