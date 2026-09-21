// Pure mapping / planning logic of the game catalog sync (items, emblems,
// battle spells) from the Moonton GMS "Academy" sources. No I/O here so it
// can be unit tested with fixtures.

/** A catalog entry as read from Moonton, ready to be merged in the database. */
export interface CatalogCandidate {
  gameId: number;
  name: string;
  icon: string | null;
  description: string | null;
  type?: string | null;
  /** Moonton-owned fields (never edited in the admin UI): always kept in sync. */
  extra?: Record<string, string | null>;
}

/** Item metadata persisted as JSON in `Item.gameMeta` for a future item page. */
export interface ItemGameMeta {
  categoryId: number | null;
  category: string | null;
  /** True when the item is an ingredient of another item. */
  isComponent: boolean;
  /** 1 = basic component, 2 = built from basic components, 3 = built from tier 2... */
  tier: number;
  /** Moonton ids of the components this item is built from. */
  buildsFrom: number[];
  /** Moonton ids of the items this one is an ingredient of. */
  buildsInto: number[];
}

/** The subset of an Item / Emblem / BattleSpell row the planner needs. */
export interface ExistingCatalogRow {
  id: string;
  name: string;
  gameId?: number | null;
  icon?: string | null;
  description?: string | null;
  type?: string | null;
  syncedAt?: Date | null;
  updatedAt?: Date | null;
  [field: string]: unknown;
}

export type CatalogWrite =
  | { kind: 'create'; data: Record<string, unknown> }
  | { kind: 'update'; id: string; name: string; data: Record<string, unknown> }
  | { kind: 'unchanged'; id: string; name: string };

export interface CatalogCounts {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

/**
 * A row whose `updatedAt` is later than its `syncedAt` by more than this was
 * edited after the last sync (by an admin or the seed): its icon and
 * description are then left alone.
 */
export const SYNC_EDIT_TOLERANCE_MS = 2000;

/** Sort offset for rows created by the sync, so they come after the seeded ones. */
export const SYNC_SORT_BASE = 100;

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
const RETIRED = /\((removed|discarded|deleted)\)/i;

/**
 * Turns GMS rich text into plain text: `<br>` becomes a line break, tags such
 * as `<font color>` are stripped, and empty "Passive - X:" header lines left by
 * the game data are dropped.
 */
export function cleanGmsText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lines = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/:$/.test(l));
  return lines.length ? lines.join('\n') : null;
}

/** In-game names used by the hand-written seed that Moonton spells differently. */
const NAME_ALIASES: Record<string, string> = { magicshoes: 'magicboots' };

/**
 * Key used to match a Moonton name with a hand-written one: case, spacing and
 * punctuation insensitive, and `Haas's` == `Haas'`.
 */
export function catalogNameKey(name: string): string {
  const key = String(name ?? '')
    .toLowerCase()
    .replace(/s['’]s\b/g, "s'")
    .replace(/[^a-z0-9]/g, '');
  return NAME_ALIASES[key] ?? key;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const isUsableName = (name: string | null): name is string =>
  !!name && !CJK.test(name) && !RETIRED.test(name);

function dedupe(list: CatalogCandidate[]): CatalogCandidate[] {
  const seenIds = new Set<number>();
  const seenNames = new Set<string>();
  return list.filter((c) => {
    const key = catalogNameKey(c.name);
    if (!Number.isFinite(c.gameId) || c.gameId <= 0 || seenIds.has(c.gameId) || seenNames.has(key)) return false;
    seenIds.add(c.gameId);
    seenNames.add(key);
    return true;
  });
}

const parseIds = (value: unknown): number[] =>
  String(value ?? '')
    .split(/[;,]/)
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

/**
 * Recipe tree from `targetequipid` ("1006;2001": the items this one builds
 * into): inverse links and tiers (1 + highest tier of the components).
 */
export function buildItemRecipes(detailRecords: any[]): Map<number, ItemGameMeta> {
  const into = new Map<number, number[]>();
  const from = new Map<number, number[]>();
  const meta = new Map<number, ItemGameMeta>();
  for (const r of detailRecords ?? []) {
    const d = r?.data ?? {};
    const id = Number(d.equipid);
    if (!Number.isFinite(id) || id <= 0) continue;
    const targets = parseIds(d.targetequipid);
    into.set(id, targets);
    for (const t of targets) from.set(t, [...(from.get(t) ?? []), id]);
    const typeId = Number(d.equiptype);
    meta.set(id, {
      categoryId: d.equiptype !== undefined && d.equiptype !== '' && Number.isFinite(typeId) ? typeId : null,
      category: str(d.equiptypename),
      isComponent: false,
      tier: 1,
      buildsFrom: [],
      buildsInto: [],
    });
  }
  const tierOf = (id: number, seen: Set<number>): number => {
    if (seen.has(id)) return 1; // guards against a cyclic recipe in bad data
    seen.add(id);
    const parts = (from.get(id) ?? []).filter((p) => meta.has(p));
    return parts.length ? 1 + Math.max(...parts.map((p) => tierOf(p, new Set(seen)))) : 1;
  };
  for (const [id, m] of meta) {
    m.buildsInto = (into.get(id) ?? []).filter((t) => meta.has(t)).sort((a, b) => a - b);
    m.buildsFrom = (from.get(id) ?? []).filter((p) => meta.has(p)).sort((a, b) => a - b);
    m.isComponent = m.buildsInto.length > 0;
    m.tier = tierOf(id, new Set());
  }
  return meta;
}

/**
 * Items from the detail source (2713995: the current shop, with stats and
 * passives). The light list (2775075) only backfills a missing icon: it also
 * contains retired items that must not reappear in the catalog.
 */
export function mapGmsItems(detailRecords: any[], listRecords: any[] = []): CatalogCandidate[] {
  const listIcons = new Map<number, string>();
  for (const r of listRecords ?? []) {
    const icon = str(r?.data?.equipicon);
    if (icon) listIcons.set(Number(r?.data?.equipid), icon);
  }
  const recipes = buildItemRecipes(detailRecords);
  const out: CatalogCandidate[] = [];
  for (const r of detailRecords ?? []) {
    const d = r?.data ?? {};
    const gameId = Number(d.equipid);
    const name = str(d.equipname);
    if (!isUsableName(name)) continue;
    const stats = cleanGmsText(d.equiptips);
    const passive = cleanGmsText(d.equipskilldesc);
    out.push({
      gameId,
      name,
      icon: str(d.equipicon) ?? listIcons.get(gameId) ?? null,
      description: [stats, passive].filter(Boolean).join('\n\n') || null,
      type: str(d.equiptypename)?.toLowerCase() ?? null,
      extra: {
        stats,
        passive,
        gameMeta: recipes.has(gameId) ? JSON.stringify(recipes.get(gameId)) : null,
      },
    });
  }
  return dedupe(out.sort((a, b) => a.gameId - b.gameId));
}

/** Battle spells (2718122): the real fields live under `data.__data`. */
export function mapGmsBattleSpells(records: any[]): CatalogCandidate[] {
  const out: CatalogCandidate[] = [];
  for (const r of records ?? []) {
    const d = r?.data ?? {};
    const inner = d.__data ?? {};
    const name = str(inner.skillname);
    if (!isUsableName(name)) continue;
    out.push({
      gameId: Number(d.battleskillid ?? inner.skillid),
      name,
      icon: str(inner.skillicon),
      description: cleanGmsText(inner.skilldesc ?? inner.skilldescemblem),
    });
  }
  return dedupe(out.sort((a, b) => a.gameId - b.gameId));
}

/** Moonton emblem title ("Tank", "All") -> catalog name ("Tank Emblem", "Common Emblem"). */
export function emblemName(title: string): string {
  const t = title.trim();
  if (/^all$/i.test(t) || /^common$/i.test(t)) return 'Common Emblem';
  return /emblem$/i.test(t) ? t : `${t} Emblem`;
}

/** Emblem sets (2740642) with their base attributes as description. */
export function mapGmsEmblems(records: any[]): CatalogCandidate[] {
  const out: CatalogCandidate[] = [];
  for (const r of records ?? []) {
    const d = r?.data ?? {};
    const title = str(d.emblem_title);
    if (!isUsableName(title)) continue;
    const detail = d.emblem_detail?.data ?? {};
    const type = title.toLowerCase() === 'all' ? 'common' : title.toLowerCase();
    out.push({
      gameId: Number(d.emblem_id ?? detail.emblemid),
      name: emblemName(title),
      icon: str(d.emblem_icon) ?? str(detail.attriicon),
      description: cleanGmsText(detail.emblemattr?.emblemattr),
      type,
    });
  }
  return dedupe(out.sort((a, b) => a.gameId - b.gameId));
}

/** True when nobody edited the row since the sync last wrote it. */
export function untouchedSinceSync(row: ExistingCatalogRow): boolean {
  if (!row.syncedAt || !row.updatedAt) return false;
  return new Date(row.updatedAt).getTime() - new Date(row.syncedAt).getTime() <= SYNC_EDIT_TOLERANCE_MS;
}

/**
 * Plans the writes merging `candidates` into `existing`, without deleting
 * anything. A row is matched by `gameId`, then by name (see catalogNameKey),
 * so rows referenced by hero builds keep their id and admin-chosen name.
 *
 * Overwrite rules for a matched row:
 * - `gameId` is always linked;
 * - `icon` / `description` are filled when empty, and refreshed only when the
 *   row still held the Moonton values and was not edited since (see
 *   untouchedSinceSync); a row keeping an admin value gets `syncedAt: null`;
 * - `type` is filled only when empty; Moonton-owned `extra` fields (item
 *   stats, passive, recipe metadata) are always refreshed;
 * - `name`, `sort`, `gold`, `cooldown` and `enabled` are never touched, so an
 *   entry an admin disabled stays disabled (created rows get the default).
 */
export function planCatalogSync(
  candidates: CatalogCandidate[],
  existing: ExistingCatalogRow[],
  now: Date,
  opts: { withType?: boolean } = {},
): CatalogWrite[] {
  const byGameId = new Map<number, ExistingCatalogRow>();
  const byName = new Map<string, ExistingCatalogRow>();
  for (const row of existing) {
    if (typeof row.gameId === 'number') byGameId.set(row.gameId, row);
    const key = catalogNameKey(row.name);
    if (!byName.has(key)) byName.set(key, row);
  }
  const claimed = new Set<string>();
  const writes: CatalogWrite[] = [];

  candidates.forEach((c, index) => {
    let row = byGameId.get(c.gameId);
    if (!row) {
      const byNameRow = byName.get(catalogNameKey(c.name));
      // A row already linked to another Moonton id is a different entry.
      if (byNameRow && (byNameRow.gameId == null || byNameRow.gameId === c.gameId)) row = byNameRow;
    }
    if (row && claimed.has(row.id)) row = undefined;

    if (!row) {
      const data: Record<string, unknown> = {
        name: c.name,
        icon: c.icon ?? undefined,
        description: c.description ?? undefined,
        gameId: c.gameId,
        syncedAt: now,
        sort: SYNC_SORT_BASE + index,
      };
      for (const [k, v] of Object.entries(c.extra ?? {})) if (v != null) data[k] = v;
      if (opts.withType && c.type) data.type = c.type;
      writes.push({ kind: 'create', data });
      return;
    }

    claimed.add(row.id);
    const refresh = untouchedSinceSync(row);
    const data: Record<string, unknown> = {};
    if (row.gameId !== c.gameId) data.gameId = c.gameId;
    if (c.icon && c.icon !== row.icon && (!row.icon || refresh)) data.icon = c.icon;
    if (c.description && c.description !== row.description && (!row.description || refresh)) {
      data.description = c.description;
    }
    if (opts.withType && c.type && !row.type) data.type = c.type;
    for (const [k, v] of Object.entries(c.extra ?? {})) {
      if (v != null && row[k] !== v) data[k] = v;
    }

    // `syncedAt` marks a row whose icon/description match Moonton. A row
    // keeping an admin value is left unmarked so later syncs never take it
    // over, even after the sync refreshes its other fields.
    const icon = 'icon' in data ? data.icon : row.icon;
    const description = 'description' in data ? data.description : row.description;
    const owned = (!c.icon || icon === c.icon) && (!c.description || description === c.description);
    if (owned && !(refresh && Object.keys(data).length === 0)) data.syncedAt = now;
    if (!owned && row.syncedAt) data.syncedAt = null;

    if (Object.keys(data).length === 0) {
      writes.push({ kind: 'unchanged', id: row.id, name: row.name });
      return;
    }
    writes.push({ kind: 'update', id: row.id, name: row.name, data });
  });

  return writes;
}
