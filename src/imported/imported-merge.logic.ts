import { BadRequestException } from '@nestjs/common';

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
 * Domain of the placeholder mailboxes. Mirrors `IMPORTED_EMAIL_DOMAIN` of
 * `src/esport/legacy-import.logic.ts` (#153); the two must stay equal, and the
 * constant is duplicated only because this branch is written next to that one.
 */
export const IMPORTED_EMAIL_DOMAIN = '@imported.mlbbtogo.local';

/**
 * `AppSetting.key` holding the import registry (`legacy id -> our id`).
 * Mirrors `LEGACY_REGISTRY_KEY` of `src/esport/legacy-import.registry.ts`.
 */
export const LEGACY_REGISTRY_KEY = 'legacy.import';

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
 * Validate the address an admin expects the owner to sign in with. Returns the
 * lowercased address; `null`/`''` means "clear it".
 */
export function normalizeExpectedEmail(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new BadRequestException('Adresse e-mail invalide.');
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(value)) {
    throw new BadRequestException('Adresse e-mail invalide.');
  }
  if (isPlaceholderEmail(value)) {
    throw new BadRequestException(
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
 * Rank real accounts against an imported profile. The profile's pseudo lives
 * in `gameNickname` (the import writes it there) and in `username`; both are
 * compared with both fields of every candidate, and the best pair wins.
 */
export function suggestTargets(
  profile: Pick<ProfileLike, 'username' | 'gameNickname'>,
  candidates: CandidateLike[],
  limit = 5,
  minScore = 0.45,
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
 * Point every legacy player id that resolved to the placeholder at the target
 * account. The document is rewritten field by field so anything this branch
 * does not know about (other maps, a future `version`) survives untouched.
 *
 * `value` is `null` when nothing changed, so the caller can skip the write.
 */
export function retargetRegistryPlayers(
  raw: string | null | undefined,
  fromUserId: string,
  toUserId: string,
): { value: string | null; legacyIds: string[] } {
  if (!raw) return { value: null, legacyIds: [] };
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { value: null, legacyIds: [] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { value: null, legacyIds: [] };
  const players = doc.players;
  if (!players || typeof players !== 'object' || Array.isArray(players)) {
    return { value: null, legacyIds: [] };
  }
  const legacyIds: string[] = [];
  for (const [legacyId, mapped] of Object.entries(players as Record<string, unknown>)) {
    if (mapped === fromUserId) {
      players[legacyId] = toUserId;
      legacyIds.push(legacyId);
    }
  }
  if (!legacyIds.length) return { value: null, legacyIds: [] };
  return { value: JSON.stringify(doc), legacyIds };
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
  { model: 'post', label: 'publications', field: 'authorId' },
  { model: 'comment', label: 'commentaires', field: 'authorId' },
  { model: 'postLike', label: 'mentions j’aime', field: 'userId' },
  { model: 'communityBuild', label: 'builds communautaires', field: 'authorId' },
  { model: 'communityBuildLike', label: 'j’aime de builds', field: 'userId' },
  { model: 'message', label: 'messages', field: 'senderId' },
  { model: 'teamRequest', label: 'demandes d’équipe', field: 'requesterId' },
  { model: 'recruitmentApplication', label: 'candidatures', field: 'userId' },
  { model: 'draftRegistration', label: 'inscriptions draft', field: 'userId' },
  { model: 'draftTeamMember', label: 'équipes de draft', field: 'userId' },
  { model: 'pickBanDraft', label: 'drafts Pick & Ban', field: 'ownerId' },
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
