import { BadRequestException } from '@nestjs/common';
import { IMPORTED_EMAIL_DOMAIN } from '../esport/legacy-import.logic';

/**
 * Pure rules of the "link an imported profile to a real account" feature
 * (issue #154).
 *
 * The legacy import (#153) creates one placeholder `User` per player of the
 * historical MLBB Togo site: `provider: 'imported'`, a mailbox in
 * `@imported.mlbbtogo.local`, an unusable password, no Google and no game
 * account. Those profiles carry the whole legacy history. When the real person
 * shows up with an account of his own, an admin merges the placeholder into
 * it: everything the placeholder holds moves over, the placeholder is deleted,
 * and the import registry is rewritten so a later run resolves the legacy
 * player id to the real account instead of recreating the placeholder.
 *
 * Nothing here touches Prisma: the service does the I/O and delegates every
 * decision to the functions below so they can be unit tested.
 */

/** `User.provider` of a placeholder created by the legacy import. */
export const IMPORTED_PROVIDER = 'imported';

/**
 * The import owns these: the domain of the placeholder mailboxes, the key of
 * its registry and the key of the backup it writes before every run. They are
 * re-exported so callers of this module have one import to make, but there is
 * a single definition, in `src/esport/legacy-import.*`.
 */
export { IMPORTED_EMAIL_DOMAIN } from '../esport/legacy-import.logic';
export {
  LEGACY_REGISTRY_BACKUP_KEY,
  LEGACY_REGISTRY_KEY,
} from '../esport/legacy-import.registry';

// ---------------------------------------------------------------------------
// Identity of an imported profile
// ---------------------------------------------------------------------------

export type ProfileLike = {
  id: string;
  username: string;
  email: string;
  provider?: string | null;
  googleId?: string | null;
  gameNickname?: string | null;
  mlbbRoleId?: number | null;
  isSystemAccount?: boolean | null;
};

/** True when the mailbox is one the import made up (nobody owns the profile). */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return String(email ?? '')
    .toLowerCase()
    .endsWith(IMPORTED_EMAIL_DOMAIN);
}

/** Placeholder mailbox rebuilt from the username (used when clearing). */
export function placeholderEmailFor(username: string): string {
  return `${String(username ?? '').toLowerCase()}${IMPORTED_EMAIL_DOMAIN}`;
}

export function isImportedProfile(u: ProfileLike | null | undefined): boolean {
  return !!u && u.provider === IMPORTED_PROVIDER && !u.isSystemAccount;
}

/**
 * An imported profile a real person has already claimed: an admin filled a
 * real address on it, or its owner signed in with Google. `googleLogin` never
 * flips `provider` off `imported`, so the provider alone cannot tell them
 * apart (same rule as the import runner).
 */
export function isAdoptedProfile(u: ProfileLike): boolean {
  return !!u.googleId || !isPlaceholderEmail(u.email);
}

// ---------------------------------------------------------------------------
// Expected email
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const MAX_EMAIL_LENGTH = 254;

/**
 * Every refusal of this feature carries a machine-readable `code` next to its
 * message: the admin interface is bilingual and translates the code, and the
 * French message is only the fallback for a client that does not know it.
 */
export function refuse(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code, message });
}

/**
 * Validate the address an admin expects the owner to sign in with. Returns the
 * lowercased address; `null`/`''` means "clear it".
 */
export function normalizeExpectedEmail(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw refuse('email_invalid', 'Adresse e-mail invalide.');
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(value)) {
    throw refuse('email_invalid', 'Adresse e-mail invalide.');
  }
  if (isPlaceholderEmail(value)) {
    throw refuse(
      'email_reserved_domain',
      `Le domaine ${IMPORTED_EMAIL_DOMAIN} est réservé aux profils importés non réclamés.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Suggestions (username / game nickname similarity)
// ---------------------------------------------------------------------------

/** Lowercase, accent-free, alphanumeric-only key (same rule as the import). */
export function normalizeKey(input: unknown): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Levenshtein distance, iterative with a single row. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** Similarity of two free-text names, in [0, 1]. */
export function similarity(a: unknown, b: unknown): number {
  const x = normalizeKey(a);
  const y = normalizeKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // A pseudo often gains or loses a prefix/suffix between the two sites
  // (`kyleghost` vs `kyleghost228`): containment is a strong signal.
  if (x.includes(y) || y.includes(x)) {
    return 0.9 * (Math.min(x.length, y.length) / Math.max(x.length, y.length)) + 0.1;
  }
  const d = editDistance(x, y);
  return Math.max(0, 1 - d / Math.max(x.length, y.length));
}

export type CandidateLike = {
  id: string;
  username: string;
  gameNickname?: string | null;
  email?: string | null;
};

export type ScoredCandidate = { id: string; score: number; matchedOn: string };

/**
 * Below this, a name match is noise (`kyle` against `zenith` scores 0.17 by
 * sheer letter overlap), so it is never offered as a suggestion.
 */
export const MIN_SUGGESTION_SCORE = 0.4;

/** Above this the two names are close enough for the UI to stop hedging. */
export const STRONG_SUGGESTION_SCORE = 0.6;

/**
 * Rank real accounts against an imported profile. The profile's pseudo lives
 * in `gameNickname` (the import writes it there) and in `username`; both are
 * compared with both fields of every candidate, and the best pair wins.
 */
export function suggestTargets(
  profile: Pick<ProfileLike, 'username' | 'gameNickname'>,
  candidates: CandidateLike[],
  limit = 5,
  minScore = MIN_SUGGESTION_SCORE,
): ScoredCandidate[] {
  const left = [profile.gameNickname, profile.username].filter(Boolean) as string[];
  const scored = candidates.map((c) => {
    let score = 0;
    let matchedOn = 'username';
    for (const l of left) {
      for (const [field, value] of [
        ['username', c.username],
        ['gameNickname', c.gameNickname],
      ] as const) {
        const s = similarity(l, value);
        if (s > score) {
          score = s;
          matchedOn = field;
        }
      }
    }
    return { id: c.id, score: Math.round(score * 100) / 100, matchedOn };
  });
  return scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Merge plan
// ---------------------------------------------------------------------------

export type TeamMemberRow = { id: string; teamId: string };
export type MatchPlayerRow = { id: string; matchId: string };

export type MembershipPlan = {
  /** Rows whose `userId` is rewritten onto the target. */
  move: string[];
  /** Rows dropped because the target is already on that team. */
  drop: string[];
};

/**
 * Team memberships respect `@@unique([teamId, userId])`: a row is moved unless
 * the target already belongs to the team, in which case the placeholder's row
 * is dropped (the target's own row is the real one, with its captain flag,
 * role and join date).
 */
export function planTeamMemberships(
  source: TeamMemberRow[],
  targetTeamIds: Iterable<string>,
): MembershipPlan {
  const taken = new Set(targetTeamIds);
  const plan: MembershipPlan = { move: [], drop: [] };
  const seen = new Set<string>();
  for (const row of source) {
    // Two placeholder rows on the same team cannot both move either.
    if (taken.has(row.teamId) || seen.has(row.teamId)) plan.drop.push(row.id);
    else {
      seen.add(row.teamId);
      plan.move.push(row.id);
    }
  }
  return plan;
}

/**
 * Match sheets respect `@@unique([matchId, userId])`. Unlike a team roster,
 * two rows on the same match are a real contradiction (the same person listed
 * twice in one series), so the merge refuses instead of picking a winner.
 */
export function matchPlayerConflicts(
  source: MatchPlayerRow[],
  targetMatchIds: Iterable<string>,
): string[] {
  const taken = new Set(targetMatchIds);
  return Array.from(new Set(source.filter((r) => taken.has(r.matchId)).map((r) => r.matchId)));
}

// ---------------------------------------------------------------------------
// Per-game picks inside `EsportMatch.games`
// ---------------------------------------------------------------------------

/**
 * Rewrite every user id stored inside the `games` JSON of a match: the per-game
 * `picks[].userId` written by the import and the per-game `mvpUserId`.
 *
 * The document is walked as raw JSON and re-serialized as-is: parsing it
 * through the typed helpers of `esport-match-details.ts` would silently drop
 * the `picks` array they do not know about.
 */
export function retargetGames(
  raw: string | null | undefined,
  fromUserId: string,
  toUserId: string,
): { value: string | null; changed: number } {
  if (!raw) return { value: raw ?? null, changed: 0 };
  let games: unknown;
  try {
    games = JSON.parse(raw);
  } catch {
    return { value: raw, changed: 0 };
  }
  if (!Array.isArray(games)) return { value: raw, changed: 0 };
  let changed = 0;
  for (const game of games) {
    if (!game || typeof game !== 'object') continue;
    const g = game as Record<string, unknown>;
    if (g.mvpUserId === fromUserId) {
      g.mvpUserId = toUserId;
      changed++;
    }
    if (!Array.isArray(g.picks)) continue;
    for (const pick of g.picks) {
      if (pick && typeof pick === 'object' && (pick as any).userId === fromUserId) {
        (pick as any).userId = toUserId;
        changed++;
      }
    }
  }
  return { value: changed ? JSON.stringify(games) : raw, changed };
}

/**
 * Two picks of the same person in one game would be a duplicate on the roster
 * of that game. It can only happen if both profiles already played it, which
 * `matchPlayerConflicts` refuses first; this check is the belt on top of it.
 */
export function gamesWouldDuplicate(
  raw: string | null | undefined,
  fromUserId: string,
  toUserId: string,
): boolean {
  if (!raw) return false;
  let games: unknown;
  try {
    games = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(games)) return false;
  return games.some((game) => {
    const picks = (game as any)?.picks;
    if (!Array.isArray(picks)) return false;
    const ids = picks.map((p: any) => p?.userId);
    return ids.includes(fromUserId) && ids.includes(toUserId);
  });
}

// ---------------------------------------------------------------------------
// Import registry
// ---------------------------------------------------------------------------

/**
 * Rewrite the import registry around a merge.
 *
 * Two things change: every legacy player id that resolved to the placeholder
 * now resolves to the target account (so a later import run adopts the real
 * account instead of recreating the placeholder), and the entries pointing at
 * rows the merge deleted are pruned (a duplicate `EsportTeamMember` the target
 * already had) so no mapping survives its row.
 *
 * The document is rewritten field by field so anything this branch does not
 * know about — other maps, a future `version` — survives untouched, and every
 * map is walked, not just the ones listed today.
 *
 * `value` is `null` when nothing changed, so the caller can skip the write.
 */
export function retargetRegistry(
  raw: string | null | undefined,
  fromUserId: string,
  toUserId: string,
  deletedIds: Iterable<string> = [],
): { value: string | null; legacyIds: string[]; pruned: number } {
  const none = { value: null, legacyIds: [] as string[], pruned: 0 };
  if (!raw) return none;
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return none;

  const gone = new Set(Array.from(deletedIds).filter(Boolean));
  const legacyIds: string[] = [];
  let pruned = 0;

  for (const [name, map] of Object.entries(doc)) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [legacyId, mapped] of Object.entries(map as Record<string, unknown>)) {
      if (typeof mapped !== 'string') continue;
      if (name === 'players' && mapped === fromUserId) {
        (map as any)[legacyId] = toUserId;
        legacyIds.push(legacyId);
      } else if (gone.has(mapped)) {
        delete (map as any)[legacyId];
        pruned++;
      }
    }
  }
  if (!legacyIds.length && !pruned) return none;
  return { value: JSON.stringify(doc), legacyIds, pruned };
}

// ---------------------------------------------------------------------------
// Season archives (`EsportSeason.summary.legacy.rosters`, written by #153)
// ---------------------------------------------------------------------------

/**
 * Repoint the archived rosters of a season summary. The import stores the
 * historical roster of every season under `summary.legacy.rosters` as
 * `{ teamId, userId, role }`, which no foreign key protects: left alone, those
 * lines would keep naming the deleted placeholder.
 *
 * A line is dropped instead of moved when the target is already on the same
 * team in the same roster, so the archive never lists him twice. Everything
 * else in the summary is preserved byte for byte.
 */
export function retargetSeasonSummary(
  raw: string | null | undefined,
  fromUserId: string,
  toUserId: string,
): { value: string | null; changed: number; dropped: number } {
  const none = { value: null, changed: 0, dropped: 0 };
  if (!raw) return none;
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return none;
  const rosters = doc?.legacy?.rosters;
  if (!Array.isArray(rosters)) return none;

  const held = new Set(
    rosters
      .filter((r: any) => r && r.userId === toUserId)
      .map((r: any) => String(r.teamId ?? '')),
  );
  const kept: any[] = [];
  let changed = 0;
  let dropped = 0;
  for (const line of rosters) {
    if (!line || typeof line !== 'object' || line.userId !== fromUserId) {
      kept.push(line);
      continue;
    }
    if (held.has(String(line.teamId ?? ''))) {
      dropped++;
      continue;
    }
    held.add(String(line.teamId ?? ''));
    kept.push({ ...line, userId: toUserId });
    changed++;
  }
  if (!changed && !dropped) return none;
  doc.legacy.rosters = kept;
  return { value: JSON.stringify(doc), changed, dropped };
}

// ---------------------------------------------------------------------------
// What must not be merged blindly
// ---------------------------------------------------------------------------

/**
 * Collections an imported placeholder can never legitimately hold a row in: it
 * has no usable password, no Google and no game account, so it has never
 * signed in to write any of this. Finding one means the profile is not a
 * placeholder any more (somebody adopted it), and reassigning authored content
 * behind the admin's back is not something this operation may decide, so the
 * merge stops and says which collection is in the way.
 *
 * Keyed by the Prisma model, valued by the `where` used to count.
 */
export const BLOCKING_COLLECTIONS = [
  { model: 'post', field: 'authorId' },
  { model: 'comment', field: 'authorId' },
  { model: 'postLike', field: 'userId' },
  { model: 'communityBuild', field: 'authorId' },
  { model: 'communityBuildLike', field: 'userId' },
  { model: 'message', field: 'senderId' },
  { model: 'teamRequest', field: 'requesterId' },
  { model: 'recruitmentApplication', field: 'userId' },
  { model: 'draftRegistration', field: 'userId' },
  { model: 'draftTeamMember', field: 'userId' },
  { model: 'pickBanDraft', field: 'ownerId' },
] as const;

/**
 * Rows that disappear with the placeholder instead of moving: they describe
 * the placeholder's own (empty) progression, not the legacy history. The
 * import guard (#153) guarantees an imported profile never earned XP, an
 * achievement or a frame, and it has no game account, so these are residue.
 */
export const DROPPED_COLLECTIONS = [
  { model: 'notification', field: 'userId' },
  { model: 'pushSubscription', field: 'userId' },
  { model: 'threadRead', field: 'userId' },
  { model: 'userProgress', field: 'userId' },
  { model: 'xpEvent', field: 'userId' },
  { model: 'xpCounter', field: 'userId' },
  { model: 'userAchievement', field: 'userId' },
  { model: 'userMission', field: 'userId' },
  { model: 'userFrame', field: 'userId' },
  { model: 'gameSeasonStats', field: 'userId' },
  { model: 'gameMatch', field: 'userId' },
  { model: 'communityBuildQuota', field: 'userId' },
] as const;

// ---------------------------------------------------------------------------
// Refusal reasons
// ---------------------------------------------------------------------------

/**
 * Why a merge is refused, as a code the UI translates. The API never returns a
 * ready-made sentence here: the admin interface is bilingual, and a French
 * string baked in the backend leaks into the English UI.
 */
export type MergeReason =
  /** The target already has a match sheet on `count` of the source's matches. */
  | { code: 'match_conflict'; count: number }
  /** `count` games already list both accounts. */
  | { code: 'game_duplicate'; count: number }
  /** The placeholder holds `count` rows of authored content in `model`. */
  | { code: 'blocking'; model: string; count: number };

export function mergeReasons(
  conflicts: readonly unknown[],
  duplicatedGames: readonly unknown[],
  blocking: readonly { model: string; count: number }[],
): MergeReason[] {
  const out: MergeReason[] = [];
  if (conflicts.length) out.push({ code: 'match_conflict', count: conflicts.length });
  if (duplicatedGames.length) out.push({ code: 'game_duplicate', count: duplicatedGames.length });
  for (const b of blocking) out.push({ code: 'blocking', model: b.model, count: b.count });
  return out;
}

// ---------------------------------------------------------------------------
// Replay of an already-applied merge
// ---------------------------------------------------------------------------

/**
 * Did this exact pair already go through a merge?
 *
 * The placeholder and the registry are rewritten in one transaction, so once
 * the profile is gone the registry no longer names it: the only lasting proof
 * that it existed, and that it went into THIS target, is the `imported.merge`
 * entry the operation wrote. Without that proof a retry must not be treated as
 * a replay — any well-formed object id would otherwise recompute an arbitrary
 * account and leave an admin log line behind it.
 */
export function wasMergedInto(
  logs: readonly { action?: string | null; target?: string | null; details?: string | null }[],
  sourceId: string,
  targetId: string,
): boolean {
  if (!sourceId || !targetId) return false;
  return logs.some(
    (l) =>
      l.action === 'imported.merge' &&
      l.target === targetId &&
      typeof l.details === 'string' &&
      l.details.includes(sourceId),
  );
}
