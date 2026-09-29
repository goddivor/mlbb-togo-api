/**
 * Pure mapping rules for the import of the legacy MLBB Togo site
 * (issue #153). The dump is a read-only export of their Supabase tables; the
 * runner (`prisma/import-legacy.ts`) only does I/O and delegates every
 * decision to the functions below so they can be unit tested.
 *
 * Nothing here touches Prisma or the filesystem.
 */

import { MatchFormat, MatchPick, MatchStage } from './esport-match-details';

// ---------------------------------------------------------------------------
// Source rows (only the columns we use)
// ---------------------------------------------------------------------------

export type LegacySeason = { id: number; name: string; is_active: boolean; created_at: string };
export type LegacyTeam = {
  id: number;
  name: string;
  short_name: string | null;
  logo_url: string | null;
  season_id: number;
  created_at: string;
};
export type LegacyPlayer = {
  id: number;
  name: string;
  role: string | null;
  team_id: number | null;
  avatar_url: string | null;
  custom_title: string | null;
  created_at: string;
};
export type LegacyMatch = {
  id: number;
  season_id: number;
  type: string | null;
  team1_id: number;
  team2_id: number;
  score1: number | null;
  score2: number | null;
  played_at: string | null;
  best_of: number | null;
};
export type LegacyGame = {
  id: string;
  match_id: number;
  game_number: number;
  winner_team_id: number | null;
};
export type LegacyGamePlayer = {
  id: string;
  game_id: string;
  player_id: number;
  team_id: number;
  hero_id: string | null;
  is_sub: boolean | null;
};
export type LegacyHero = { id: string; name: string; slug: string | null };
export type LegacyAward = {
  id: number;
  season_id: number;
  title: string | null;
  custom_label: string | null;
  description: string | null;
  player_id: number | null;
  team_id: number | null;
};
export type LegacyPlayoffMatch = {
  season_id: number;
  round: number;
  match_order: number;
  team1_id: number;
  team2_id: number;
  winner_id: number | null;
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lowercase, accent-free, alphanumeric-only key used for every dedupe. */
export function normalizeKey(input: unknown): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Readable ASCII slug (same rules as the seasons module). */
export function slugify(input: unknown, max = 80): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** Username slug of an imported pseudo: readable, unique-able, ASCII. */
export function slugifyUsername(input: unknown): string {
  return slugify(input, 28) || 'joueur';
}

/** Domain of the placeholder mailboxes: an address here means "not claimed". */
export const IMPORTED_EMAIL_DOMAIN = '@imported.mlbbtogo.local';

/** Placeholder mailbox of an imported profile (never a real address). */
export function importedEmail(slug: string): string {
  return `${slug}${IMPORTED_EMAIL_DOMAIN}`;
}

// ---------------------------------------------------------------------------
// People (players -> imported profiles)
// ---------------------------------------------------------------------------

export const LANE_BY_SOURCE_ROLE: Record<string, string> = {
  exp: 'exp',
  gold: 'gold',
  jungle: 'jungle',
  mid: 'mid',
  roam: 'roam',
};

export function laneOf(role: string | null | undefined): string | null {
  return LANE_BY_SOURCE_ROLE[normalizeKey(role)] ?? null;
}

/**
 * Look-alike pseudos that the normalization cannot merge but that are the same
 * player. The owner arbitrated these groups by hand (same lane, coherent team
 * path across seasons). The first entry of each group is the canonical pseudo
 * shown on the profile. An alias only ever matches the exact spellings listed
 * here, after the usual normalization: it never swallows an unrelated pseudo.
 */
export const PLAYER_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['Gabrielle', 'Gabrielle~555', 'Gabriellle~555'],
  ['Moon', 'MOON@4215'],
  ['Cresus', 'It is Cresus'],
  ['Atomic Weight', 'TheAtomicWeight'],
  ['PIERRO SMK', 'Pierrosmoke'],
];

/** Normalized spelling -> canonical pseudo, built from the alias groups. */
const ALIAS_CANONICAL: ReadonlyMap<string, string> = new Map(
  PLAYER_ALIAS_GROUPS.flatMap((group) => group.map((name) => [normalizeKey(name), group[0]] as const)),
);

/** The canonical pseudo the owner assigned to `name`, or null when it is not an alias. */
export function canonicalAlias(name: string | null | undefined): string | null {
  return ALIAS_CANONICAL.get(normalizeKey(name)) ?? null;
}

export type MergeSource = 'normalization' | 'owner' | 'both';

export type ImportedPerson = {
  /** Normalized dedupe key. */
  key: string;
  /** Pseudo kept for display (the most recent spelling wins). */
  displayName: string;
  /** Every spelling found upstream, in first-seen order. */
  variants: string[];
  /** Their player ids, all seasons. */
  sourceIds: number[];
  avatar: string | null;
  /** Lane of the most recent row. */
  lane: string | null;
  title: string | null;
  /** Why several spellings were merged (null for a single spelling). */
  mergeSource: MergeSource | null;
};

/**
 * One person per normalized pseudo, plus the owner's alias groups. Their table holds one row per player and
 * per season, and the spelling drifts between seasons (`Kyle_Ghost` /
 * `Kyle_ghost`), so the latest row wins for the display fields.
 */
export function dedupePlayers(rows: LegacyPlayer[]): ImportedPerson[] {
  const byKey = new Map<string, ImportedPerson>();
  const aliased = new Set<string>();
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  for (const row of ordered) {
    const ownKey = normalizeKey(row.name);
    if (!ownKey) continue;
    const canonical = canonicalAlias(row.name);
    const key = canonical ? normalizeKey(canonical) : ownKey;
    const person = byKey.get(key) ?? {
      key,
      displayName: row.name.trim(),
      variants: [],
      sourceIds: [],
      avatar: null,
      lane: null,
      title: null,
      mergeSource: null,
    };
    // Variants keep the raw spelling (trailing space included): the report
    // must show exactly what was merged.
    if (!person.variants.includes(row.name)) person.variants.push(row.name);
    person.sourceIds.push(row.id);
    // Latest row wins for the display name, except for an arbitrated group
    // whose canonical pseudo is fixed by the owner.
    person.displayName = canonical ?? row.name.trim();
    // `aliasOnly` = spellings that the normalization alone would keep apart.
    if (canonical && ownKey !== key) aliased.add(key);
    person.avatar = row.avatar_url || person.avatar;
    person.lane = laneOf(row.role) ?? person.lane;
    person.title = row.custom_title || person.title;
    byKey.set(key, person);
  }
  for (const [key, person] of byKey) {
    if (person.variants.length < 2) continue;
    // Spellings sharing a normalized form were merged by the normalization.
    const forms = new Set(person.variants.map((v) => normalizeKey(v)));
    const byNormalization = forms.size < person.variants.length;
    const byOwner = aliased.has(key);
    person.mergeSource = byOwner && byNormalization ? 'both' : byOwner ? 'owner' : 'normalization';
  }
  return Array.from(byKey.values());
}

export type UsernameAssignment = {
  key: string;
  username: string;
  /** Placeholder mailbox, derived from the username so it stays unique. */
  email: string;
  /** Set when the natural slug was already taken by an existing member. */
  collidedWith: string | null;
};

/**
 * Give every person a free username and the matching placeholder mailbox.
 *
 * `taken` holds the usernames of the accounts the import must not steal —
 * real members only. The profiles created by a previous run are deliberately
 * left out of it, otherwise a second run would suffix every slug and create
 * 51 duplicates instead of finding the existing profiles again.
 */
export function assignUsernames(
  people: ImportedPerson[],
  taken: Iterable<string>,
): UsernameAssignment[] {
  const used = new Set(Array.from(taken, (u) => u.toLowerCase()));
  return people.map((p) => {
    const base = slugifyUsername(p.displayName);
    if (!used.has(base)) {
      used.add(base);
      return { key: p.key, username: base, email: importedEmail(base), collidedWith: null };
    }
    let i = 2;
    while (used.has(`${base}-${i}`)) i++;
    const username = `${base}-${i}`;
    used.add(username);
    return { key: p.key, username, email: importedEmail(username), collidedWith: base };
  });
}

// ---------------------------------------------------------------------------
// Heroes
// ---------------------------------------------------------------------------

/** Their spellings that do not exist in our catalog, mapped by hand. */
export const HERO_FIX_TABLE: Record<string, string> = {
  cecillion: 'Cecilion',
  terrizla: 'Terizla',
  minsithar: 'Minsitthar',
  maikohetkupa: 'Popol and Kupa',
};

export type HeroRef = { id: string; name: string };

/** Index our catalog by normalized name. */
export function buildHeroIndex(catalog: HeroRef[]): Map<string, HeroRef> {
  return new Map(catalog.map((h) => [normalizeKey(h.name), h]));
}

/** Resolve one of their hero names against our catalog (null = unresolved). */
export function resolveHero(name: string | null | undefined, index: Map<string, HeroRef>): HeroRef | null {
  const key = normalizeKey(name);
  if (!key) return null;
  const fixed = HERO_FIX_TABLE[key];
  return index.get(fixed ? normalizeKey(fixed) : key) ?? null;
}

/**
 * Resolve their whole hero table. `played` narrows the abort rule: only a hero
 * that someone actually picked must be resolvable.
 */
export function resolveHeroTable(
  heroes: LegacyHero[],
  index: Map<string, HeroRef>,
  played: Set<string>,
): { resolved: Map<string, HeroRef>; unmatched: string[]; unmatchedPlayed: string[] } {
  const resolved = new Map<string, HeroRef>();
  const unmatched: string[] = [];
  const unmatchedPlayed: string[] = [];
  for (const h of heroes) {
    const ours = resolveHero(h.name, index);
    if (ours) {
      resolved.set(h.id, ours);
      continue;
    }
    unmatched.push(h.name);
    if (played.has(h.id)) unmatchedPlayed.push(h.name);
  }
  return { resolved, unmatched, unmatchedPlayed };
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

export type MappedSeason = {
  sourceId: number;
  name: string;
  slug: string;
  number: number;
  status: 'active' | 'closed';
  isActive: boolean;
};

/** Number the seasons 1..n by creation date; only the live one stays active. */
export function mapSeasons(rows: LegacySeason[]): MappedSeason[] {
  return [...rows]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((s, i) => ({
      sourceId: s.id,
      name: s.name.trim(),
      slug: slugify(s.name) || `saison-${i + 1}`,
      number: i + 1,
      status: s.is_active ? ('active' as const) : ('closed' as const),
      isActive: !!s.is_active,
    }));
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export type MappedTeam = {
  key: string;
  name: string;
  image: string | null;
  shortName: string | null;
  sourceIds: number[];
};

/**
 * One team per name: the legacy site duplicated a team for every season it
 * played, so `ETERNUM ALPHA` exists three times with three ids.
 */
export function dedupeTeams(rows: LegacyTeam[]): MappedTeam[] {
  const byKey = new Map<string, MappedTeam>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const key = normalizeKey(row.name);
    if (!key) continue;
    const team = byKey.get(key) ?? {
      key,
      name: row.name.trim(),
      image: null,
      shortName: null,
      sourceIds: [],
    };
    team.sourceIds.push(row.id);
    team.image = row.logo_url || team.image;
    team.shortName = row.short_name || team.shortName;
    byKey.set(key, team);
  }
  return Array.from(byKey.values());
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/** Their `type` column maps 1:1 onto our stages (unknown -> scrim). */
export function stageOf(type: string | null | undefined): MatchStage {
  const key = normalizeKey(type);
  if (key === 'league') return 'league';
  if (key === 'playoff' || key === 'playoffs') return 'playoff';
  return 'scrim';
}

/** Legacy `type` column kept meaningful next to the stage. */
export function typeOf(stage: MatchStage): string {
  return stage === 'scrim' ? 'friendly' : 'official';
}

const FORMATS: MatchFormat[] = ['bo1', 'bo3', 'bo5', 'bo7'];

/**
 * Series format. Their `best_of` is sometimes even (a "BO2") or simply wrong
 * (a BO1 with a 2-0), so the declared value is rounded up to the next odd
 * format and then widened until it can hold the recorded score and games.
 */
export function formatOf(
  bestOf: number | null | undefined,
  scoreA: number,
  scoreB: number,
  gamesCount = 0,
): MatchFormat {
  const declared = Number(bestOf);
  const odd = Number.isFinite(declared) && declared > 0 ? declared + ((declared + 1) % 2) : 1;
  const needed = Math.max(2 * Math.max(scoreA, scoreB) - 1, gamesCount, odd, 1);
  return FORMATS.find((f) => Number(f.slice(2)) >= needed) ?? 'bo7';
}

/** Winner of a match from its score (null on a draw). */
export function winnerOf(
  scoreA: number,
  scoreB: number,
  teamAId: string,
  teamBId: string,
): string | null {
  if (scoreA > scoreB) return teamAId;
  if (scoreB > scoreA) return teamBId;
  return null;
}

// ---------------------------------------------------------------------------
// Games and picks
// ---------------------------------------------------------------------------

export type PickInput = {
  gameId: string;
  gameNumber: number;
  winnerTeamId: string | null;
  screenshot?: string | null;
  players: {
    userId: string;
    teamId: string;
    hero: HeroRef | null;
    isSub: boolean;
  }[];
};

export type BuiltGame = {
  number: number;
  winnerTeamId: string | null;
  duration: null;
  mvpUserId: null;
  screenshot: string | null;
  picks?: MatchPick[];
};

/**
 * Per-game details of one match. Duration and MVP are always null: the legacy
 * site never recorded them (`matches.mvp_player_id` is null on every row).
 */
export function buildGames(inputs: PickInput[]): BuiltGame[] {
  return [...inputs]
    .sort((a, b) => a.gameNumber - b.gameNumber)
    .map((g, i) => {
      const picks: MatchPick[] = g.players.map((p) => ({
        userId: p.userId,
        teamId: p.teamId,
        heroId: p.hero?.id ?? null,
        hero: p.hero?.name ?? null,
        isSub: p.isSub,
      }));
      return {
        number: i + 1,
        winnerTeamId: g.winnerTeamId,
        duration: null,
        mvpUserId: null,
        screenshot: g.screenshot ?? null,
        ...(picks.length ? { picks } : {}),
      };
    });
}

export type MatchPlayerRow = {
  userId: string;
  teamId: string;
  hero: string | null;
  heroId: string | null;
  role: string | null;
};

/**
 * One `EsportMatchPlayer` row per player of the match. Upstream has no KDA, so
 * the row only carries the hero the player used most in the series (ties broken
 * by the first game he played it in) and his lane.
 */
export function buildMatchPlayers(
  games: BuiltGame[],
  laneOfUser: (userId: string) => string | null = () => null,
): MatchPlayerRow[] {
  type Acc = {
    userId: string;
    teamId: string;
    counts: Map<string, { hero: MatchPick; count: number; first: number }>;
  };
  const byUser = new Map<string, Acc>();
  let seq = 0;
  for (const g of games) {
    for (const pick of g.picks ?? []) {
      const acc = byUser.get(pick.userId) ?? {
        userId: pick.userId,
        teamId: pick.teamId,
        counts: new Map(),
      };
      // The team of the last game played wins (a sub can switch sides between
      // games only in the data, never in a real series).
      acc.teamId = pick.teamId;
      const heroKey = pick.heroId ?? normalizeKey(pick.hero);
      if (heroKey) {
        const cur = acc.counts.get(heroKey);
        if (cur) cur.count++;
        else acc.counts.set(heroKey, { hero: pick, count: 1, first: seq++ });
      }
      byUser.set(pick.userId, acc);
    }
  }
  return Array.from(byUser.values()).map((acc) => {
    const best = Array.from(acc.counts.values()).sort(
      (a, b) => b.count - a.count || a.first - b.first,
    )[0];
    return {
      userId: acc.userId,
      teamId: acc.teamId,
      hero: best?.hero.hero ?? null,
      heroId: best?.hero.heroId ?? null,
      role: laneOfUser(acc.userId),
    };
  });
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

const AWARD_CATEGORY_BY_TITLE: Record<string, string> = {
  mvp: 'mvp',
  bestjungler: 'best_jungle',
  bestroamer: 'best_roam',
  bestexplaner: 'best_exp',
  bestmidmage: 'best_mid',
  bestgoldlaner: 'best_gold',
};

/** Their free-text award titles mapped onto our fixed categories. */
export function awardCategoryOf(title: string | null | undefined): string {
  return AWARD_CATEGORY_BY_TITLE[normalizeKey(title)] ?? 'custom';
}

// ---------------------------------------------------------------------------
// Playoffs bracket
// ---------------------------------------------------------------------------

export type Podium = { placement: 1 | 2 | 3; teamId: string }[];

/**
 * Podium of a season from its bracket: in the last round, order 1 is the final
 * (winner 1st, loser 2nd) and order 2 the third-place match. Bracket slots
 * without a score are kept out of `EsportMatch` on purpose (the two real
 * playoff matches already exist in their `matches` table).
 */
export function podiumFromBracket(
  rows: LegacyPlayoffMatch[],
  teamIdOf: (sourceTeamId: number) => string | null,
): Podium {
  if (!rows.length) return [];
  const lastRound = Math.max(...rows.map((r) => r.round));
  const final = rows.find((r) => r.round === lastRound && r.match_order === 1);
  const third = rows.find((r) => r.round === lastRound && r.match_order === 2);
  const podium: Podium = [];
  if (final?.winner_id) {
    const champion = teamIdOf(final.winner_id);
    const runnerUpSource = final.winner_id === final.team1_id ? final.team2_id : final.team1_id;
    const runnerUp = teamIdOf(runnerUpSource);
    if (champion) podium.push({ placement: 1, teamId: champion });
    if (runnerUp) podium.push({ placement: 2, teamId: runnerUp });
  }
  if (third?.winner_id) {
    const bronze = teamIdOf(third.winner_id);
    if (bronze) podium.push({ placement: 3, teamId: bronze });
  }
  return podium;
}

// ---------------------------------------------------------------------------
// Communications
// ---------------------------------------------------------------------------

/** YouTube video id of a watch / youtu.be / embed URL (null when absent). */
export function youtubeIdFrom(url: string | null | undefined): string | null {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  return null;
}

export const POST_KINDS = ['announcement', 'community', 'stream'] as const;

/** Images of a communication: the gallery column plus the cover, deduped. */
export function postImages(images: unknown, cover: unknown): string[] {
  const list = Array.isArray(images)
    ? images
    : String(images ?? '')
        .split(/[\n,]/)
        .map((s) => s.trim());
  const all = [...list, cover]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => /^https?:\/\//.test(v));
  return Array.from(new Set(all)).slice(0, 6);
}
