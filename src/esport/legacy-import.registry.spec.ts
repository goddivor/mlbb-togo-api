import {
  LEGACY_REGISTRY_KEY,
  emptyRegistry,
  isLegacyMatchId,
  legacyMatchIds,
  parseRegistry,
  registrySize,
  serializeRegistry,
} from './legacy-import.registry';

const OID = (n: number) => String(n).padStart(24, '0');

describe('legacy import registry', () => {
  it('lives under its own AppSetting key, outside the integrations namespace', () => {
    expect(LEGACY_REGISTRY_KEY).toBe('legacy.import');
    expect(LEGACY_REGISTRY_KEY.startsWith('integration.')).toBe(false);
  });

  it('round-trips through JSON', () => {
    const registry = emptyRegistry();
    registry.players['12'] = OID(1);
    registry.matches['25'] = OID(2);
    const parsed = parseRegistry(serializeRegistry(registry, new Date('2026-09-29T00:00:00Z')));
    expect(parsed.players).toEqual({ '12': OID(1) });
    expect(parsed.matches).toEqual({ '25': OID(2) });
    expect(parsed.updatedAt).toBe('2026-09-29T00:00:00.000Z');
    expect(registrySize(parsed)).toBe(2);
  });

  it('falls back to an empty registry instead of throwing', () => {
    for (const raw of [null, undefined, '', '{bad', '[]', '"nope"', '3']) {
      expect(registrySize(parseRegistry(raw as any))).toBe(0);
    }
  });

  it('drops anything that is not a legacy id mapped to an object id', () => {
    const parsed = parseRegistry(
      JSON.stringify({
        players: { '1': OID(1), '2': 'not-an-id', '3': 42, '4': null },
        matches: 'nope',
        unknownMap: { '1': OID(9) },
      }),
    );
    expect(parsed.players).toEqual({ '1': OID(1) });
    expect(parsed.matches).toEqual({});
    expect((parsed as any).unknownMap).toBeUndefined();
  });

  it('tells whether a match was created by the import', () => {
    const registry = emptyRegistry();
    registry.matches['25'] = OID(7);
    expect(isLegacyMatchId(registry, OID(7))).toBe(true);
    expect(isLegacyMatchId(registry, OID(8))).toBe(false);
    expect(legacyMatchIds(registry)).toEqual(new Set([OID(7)]));
    expect(isLegacyMatchId(emptyRegistry(), OID(7))).toBe(false);
  });
});
