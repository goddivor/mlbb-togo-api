/**
 * Static gazetteer of Togolese cities used by the Togo map (issue #70).
 *
 * Cities are stored as free text on users / teams / tournaments / events;
 * `normalizeCity()` maps that text to one of these entries (accent and case
 * insensitive, with a few aliases). Anything unknown is bucketed under
 * `OTHER_CITY_ID`.
 */

export type TogoRegion = 'maritime' | 'plateaux' | 'centrale' | 'kara' | 'savanes';

export interface TogoCity {
  /** Stable slug used as the API identifier. */
  id: string;
  /** Canonical display name (what the city selects store). */
  name: string;
  region: TogoRegion;
  lat: number;
  lng: number;
  /** Extra spellings / neighbourhoods matched by `normalizeCity`. */
  aliases?: string[];
}

export const OTHER_CITY_ID = 'other';
export const OTHER_CITY_NAME = 'Autre';

export const TOGO_REGIONS: { id: TogoRegion; name: string }[] = [
  { id: 'maritime', name: 'Maritime' },
  { id: 'plateaux', name: 'Plateaux' },
  { id: 'centrale', name: 'Centrale' },
  { id: 'kara', name: 'Kara' },
  { id: 'savanes', name: 'Savanes' },
];

export const TOGO_CITIES: TogoCity[] = [
  // Maritime
  {
    id: 'lome',
    name: 'Lomé',
    region: 'maritime',
    lat: 6.1319,
    lng: 1.2228,
    aliases: ['agoe', 'agoe-nyive', 'agoe nyive', 'baguida', 'adidogome', 'be-kpota', 'tokoin', 'grand lome', 'lome togo'],
  },
  { id: 'tsevie', name: 'Tsévié', region: 'maritime', lat: 6.4261, lng: 1.2133 },
  { id: 'aneho', name: 'Aného', region: 'maritime', lat: 6.2278, lng: 1.5919, aliases: ['anecho'] },
  { id: 'vogan', name: 'Vogan', region: 'maritime', lat: 6.3333, lng: 1.5333 },
  { id: 'tabligbo', name: 'Tabligbo', region: 'maritime', lat: 6.5833, lng: 1.5 },
  { id: 'keve', name: 'Kévé', region: 'maritime', lat: 6.4333, lng: 0.9167 },
  { id: 'afagnan', name: 'Afagnan', region: 'maritime', lat: 6.3333, lng: 1.6667 },
  // Plateaux
  { id: 'kpalime', name: 'Kpalimé', region: 'plateaux', lat: 6.9, lng: 0.6333, aliases: ['palime'] },
  { id: 'atakpame', name: 'Atakpamé', region: 'plateaux', lat: 7.5333, lng: 1.1333 },
  { id: 'notse', name: 'Notsé', region: 'plateaux', lat: 6.95, lng: 1.1667, aliases: ['nuatja'] },
  { id: 'agou', name: 'Agou', region: 'plateaux', lat: 6.8333, lng: 0.7167, aliases: ['agou-gadzepe', 'agou gadzepe'] },
  { id: 'badou', name: 'Badou', region: 'plateaux', lat: 7.5833, lng: 0.6 },
  { id: 'anie', name: 'Anié', region: 'plateaux', lat: 7.75, lng: 1.2 },
  { id: 'amlame', name: 'Amlamé', region: 'plateaux', lat: 7.4667, lng: 0.9 },
  { id: 'danyi', name: 'Danyi', region: 'plateaux', lat: 7.1833, lng: 0.6167, aliases: ['danyi-apeyeme', 'apeyeme'] },
  { id: 'tohoun', name: 'Tohoun', region: 'plateaux', lat: 7.0, lng: 1.6667 },
  { id: 'kougnohou', name: 'Kougnohou', region: 'plateaux', lat: 7.7, lng: 0.8167 },
  // Centrale
  { id: 'sokode', name: 'Sokodé', region: 'centrale', lat: 8.9833, lng: 1.1333 },
  { id: 'tchamba', name: 'Tchamba', region: 'centrale', lat: 9.0333, lng: 1.4167 },
  { id: 'sotouboua', name: 'Sotouboua', region: 'centrale', lat: 8.5667, lng: 0.9833 },
  { id: 'blitta', name: 'Blitta', region: 'centrale', lat: 8.3167, lng: 0.9833 },
  // Kara
  { id: 'kara', name: 'Kara', region: 'kara', lat: 9.5511, lng: 1.1861, aliases: ['lama-kara', 'lama kara'] },
  { id: 'bassar', name: 'Bassar', region: 'kara', lat: 9.25, lng: 0.7833 },
  { id: 'niamtougou', name: 'Niamtougou', region: 'kara', lat: 9.7667, lng: 1.1 },
  { id: 'bafilo', name: 'Bafilo', region: 'kara', lat: 9.35, lng: 1.2667 },
  { id: 'kande', name: 'Kandé', region: 'kara', lat: 9.9667, lng: 1.0333 },
  { id: 'pagouda', name: 'Pagouda', region: 'kara', lat: 9.75, lng: 1.3333 },
  { id: 'ketao', name: 'Kétao', region: 'kara', lat: 9.6, lng: 1.35 },
  { id: 'guerin-kouka', name: 'Guérin-Kouka', region: 'kara', lat: 9.6833, lng: 0.6, aliases: ['guerin kouka'] },
  // Savanes
  { id: 'dapaong', name: 'Dapaong', region: 'savanes', lat: 10.8667, lng: 0.2, aliases: ['dapaongo', 'dapango'] },
  { id: 'mango', name: 'Mango', region: 'savanes', lat: 10.3667, lng: 0.4667, aliases: ['sansanne-mango', 'sansanne mango', 'sansanne'] },
  { id: 'cinkasse', name: 'Cinkassé', region: 'savanes', lat: 11.0167, lng: 0.0333, aliases: ['cinkasse', 'sinkasse'] },
  { id: 'tandjouare', name: 'Tandjouaré', region: 'savanes', lat: 10.7, lng: 0.15 },
];

/** Lower-case, accent-free, punctuation-collapsed key used for matching. */
export function cityKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const INDEX: Map<string, TogoCity> = (() => {
  const map = new Map<string, TogoCity>();
  for (const city of TOGO_CITIES) {
    map.set(cityKey(city.id), city);
    map.set(cityKey(city.name), city);
    for (const alias of city.aliases ?? []) map.set(cityKey(alias), city);
  }
  return map;
})();

/**
 * Maps free text ("lomé", "LOME", "Agoè-Nyivé", "Sokodé, Togo") to a known
 * city, or `null` when it is empty, "Autre" or unknown.
 */
export function normalizeCity(raw?: string | null): TogoCity | null {
  if (!raw) return null;
  const key = cityKey(raw);
  if (!key || key === cityKey(OTHER_CITY_NAME) || key === OTHER_CITY_ID) return null;
  const direct = INDEX.get(key);
  if (direct) return direct;
  // "Sokodé, Togo" / "Kara (Togo)": keep the first segment.
  const first = key.split(' togo')[0].split(' ')[0];
  return INDEX.get(first) ?? null;
}

export function findCity(id: string): TogoCity | null {
  return TOGO_CITIES.find((c) => c.id === id) ?? null;
}
