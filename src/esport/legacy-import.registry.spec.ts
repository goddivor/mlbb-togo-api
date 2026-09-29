import {
  LEGACY_REGISTRY_BACKUP_KEY,
  LEGACY_REGISTRY_KEY,
  emptyRegistry,
  isLegacyMatchId,
  mergeRegistry,
  legacyMatchIds,
  parseRegistry,
  registrySize,
  serializeRegistry,
  foreignMappings,
  objectIdTime,
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

  it('keeps its backup under its own key', () => {
    expect(LEGACY_REGISTRY_BACKUP_KEY).toBe('legacy.import.backup');
    expect(LEGACY_REGISTRY_BACKUP_KEY).not.toBe(LEGACY_REGISTRY_KEY);
  });

  it('merges without ever losing a mapping', () => {
    const base = emptyRegistry();
    base.players['1'] = OID(1);
    base.matches['10'] = OID(10);
    const extra = emptyRegistry();
    extra.players['2'] = OID(2);
    // The same legacy id pointing somewhere else: the newer value wins.
    extra.matches['10'] = OID(11);
    const merged = mergeRegistry(base, extra);
    expect(merged.players).toEqual({ '1': OID(1), '2': OID(2) });
    expect(merged.matches).toEqual({ '10': OID(11) });
    // A run that recorded nothing must not shrink the registry it started from.
    expect(mergeRegistry(base, emptyRegistry()).players).toEqual(base.players);
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

describe('registry fingerprint', () => {
  const idAt = (ms: number) => Math.floor(ms / 1000).toString(16).padStart(8, '0') + 'a'.repeat(16);

  it('reads the creation time of an object id', () => {
    expect(objectIdTime(idAt(1_700_000_000_000))).toBe(1_700_000_000_000);
  });

  it('refuses mappings older than the first run, accepts newer ones', () => {
    const registry = emptyRegistry();
    registry.firstRunAt = 1_700_000_000_000;
    registry.matches['4'] = idAt(1_600_000_000_000);
    registry.matches['5'] = idAt(1_700_000_100_000);
    expect(foreignMappings(registry)).toEqual([`matches[4] -> ${idAt(1_600_000_000_000)}`]);
  });

  it('checks nothing on a registry without fingerprint', () => {
    const registry = emptyRegistry();
    registry.matches['4'] = idAt(1_000_000_000_000);
    expect(foreignMappings(registry)).toEqual([]);
  });

  it('round-trips the fingerprint', () => {
    const registry = emptyRegistry();
    registry.firstRunAt = 42;
    expect(parseRegistry(serializeRegistry(registry)).firstRunAt).toBe(42);
  });
});
