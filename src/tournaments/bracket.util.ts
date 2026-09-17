/**
 * Pure helpers for single-elimination tournament brackets.
 * The bracket is stored as a flat list of matches (JSON) on the Tournament.
 */

export type BracketMatchStatus =
  | 'pending' // waiting for teams or not yet scheduled
  | 'scheduled'
  | 'live'
  | 'finished'
  | 'bye'; // auto-advanced (missing opponent)

export interface BracketMatch {
  id: string;
  round: number; // 1-based
  position: number; // 0-based within the round
  teamAId: string | null;
  teamBId: string | null;
  scoreA: number;
  scoreB: number;
  winnerTeamId: string | null;
  status: BracketMatchStatus;
  scheduledAt: string | null; // ISO date
  streamUrl: string | null;
}

export interface BracketTeamRef {
  id: string;
  name?: string;
  logo?: string | null;
}

export type Seeding = 'random' | 'order';

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function matchId(round: number, position: number): string {
  return `r${round}m${position}`;
}

export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/**
 * Spread byes across the bracket instead of stacking them at the end:
 * the first `size - n` seeds get a bye (standard seeding order).
 */
function seedSlots<T>(seeds: T[], size: number): Array<T | null> {
  const n = seeds.length;
  const byes = size - n;
  const slots: Array<T | null> = [];
  let s = 0;
  for (let p = 0; p < size / 2; p++) {
    // Slot A always gets a team; slot B is a bye for the first `byes` matches.
    slots.push(seeds[s++] ?? null);
    if (p < byes) slots.push(null);
    else slots.push(seeds[s++] ?? null);
  }
  return slots;
}

function emptyMatch(round: number, position: number): BracketMatch {
  return {
    id: matchId(round, position),
    round,
    position,
    teamAId: null,
    teamBId: null,
    scoreA: 0,
    scoreB: 0,
    winnerTeamId: null,
    status: 'pending',
    scheduledAt: null,
    streamUrl: null,
  };
}

/** Build a full single-elimination bracket (byes for non-power-of-two). */
export function generateBracket(teams: BracketTeamRef[], seeding: Seeding = 'random'): BracketMatch[] {
  const seeds = seeding === 'random' ? shuffle(teams) : [...teams];
  const n = seeds.length;
  if (n < 2) return [];
  const size = nextPowerOfTwo(n);
  const totalRounds = Math.log2(size);
  const slots = seedSlots(seeds, size);

  const matches: BracketMatch[] = [];
  for (let p = 0; p < size / 2; p++) {
    const teamA = slots[p * 2];
    const teamB = slots[p * 2 + 1];
    const m = emptyMatch(1, p);
    m.teamAId = teamA?.id ?? null;
    m.teamBId = teamB?.id ?? null;
    if (teamA && !teamB) {
      m.winnerTeamId = teamA.id;
      m.status = 'bye';
    } else if (teamB && !teamA) {
      m.winnerTeamId = teamB.id;
      m.status = 'bye';
    }
    matches.push(m);
  }
  for (let r = 2; r <= totalRounds; r++) {
    const count = size / Math.pow(2, r);
    for (let p = 0; p < count; p++) matches.push(emptyMatch(r, p));
  }
  // Propagate byes.
  for (const m of matches.filter((x) => x.round === 1 && x.winnerTeamId)) {
    advanceWinner(matches, m);
  }
  return matches;
}

export function findMatch(matches: BracketMatch[], id: string): BracketMatch | undefined {
  return matches.find((m) => m.id === id);
}

export function totalRounds(matches: BracketMatch[]): number {
  return matches.reduce((max, m) => Math.max(max, m.round), 0);
}

/** Reset a match (and everything downstream) when a slot changes. */
function resetDownstream(matches: BracketMatch[], match: BracketMatch) {
  match.scoreA = 0;
  match.scoreB = 0;
  match.winnerTeamId = null;
  if (match.status === 'finished' || match.status === 'live' || match.status === 'bye') {
    match.status = match.scheduledAt ? 'scheduled' : 'pending';
  }
  const next = findMatch(matches, matchId(match.round + 1, Math.floor(match.position / 2)));
  if (!next) return;
  const slot = match.position % 2 === 0 ? 'teamAId' : 'teamBId';
  if (next[slot] !== null) {
    next[slot] = null;
    resetDownstream(matches, next);
  }
}

/** Put the winner of `match` into the next round slot; mutates `matches`. */
export function advanceWinner(matches: BracketMatch[], match: BracketMatch) {
  const next = findMatch(matches, matchId(match.round + 1, Math.floor(match.position / 2)));
  if (!next) return; // final
  const slot = match.position % 2 === 0 ? 'teamAId' : 'teamBId';
  if (next[slot] !== match.winnerTeamId) {
    next[slot] = match.winnerTeamId;
    // A different team now sits here: any downstream result is void.
    if (next.winnerTeamId) resetDownstream(matches, next);
  }
}

/**
 * Apply a result. The winner is inferred from the scores unless given
 * explicitly (draw requires an explicit winner). Returns the updated list.
 */
export function applyResult(
  matches: BracketMatch[],
  id: string,
  scoreA: number,
  scoreB: number,
  winnerTeamId?: string | null,
): { matches: BracketMatch[]; error?: string } {
  const list = matches.map((m) => ({ ...m }));
  const match = findMatch(list, id);
  if (!match) return { matches, error: 'MATCH_NOT_FOUND' };
  if (!match.teamAId || !match.teamBId) return { matches, error: 'MATCH_INCOMPLETE' };
  let winner = winnerTeamId ?? null;
  if (!winner) {
    if (scoreA === scoreB) return { matches, error: 'WINNER_REQUIRED' };
    winner = scoreA > scoreB ? match.teamAId : match.teamBId;
  }
  if (winner !== match.teamAId && winner !== match.teamBId) {
    return { matches, error: 'WINNER_NOT_IN_MATCH' };
  }
  match.scoreA = scoreA;
  match.scoreB = scoreB;
  match.winnerTeamId = winner;
  match.status = 'finished';
  advanceWinner(list, match);
  return { matches: list };
}

export function isFinal(matches: BracketMatch[], match: BracketMatch): boolean {
  return match.round === totalRounds(matches);
}

/** Human-readable round key (used by the frontend for i18n). */
export function roundKey(round: number, total: number): string {
  const fromEnd = total - round;
  if (fromEnd === 0) return 'final';
  if (fromEnd === 1) return 'semi';
  if (fromEnd === 2) return 'quarter';
  return 'round';
}

export function groupRounds(matches: BracketMatch[]) {
  const total = totalRounds(matches);
  const rounds: { round: number; key: string; matches: BracketMatch[] }[] = [];
  for (let r = 1; r <= total; r++) {
    rounds.push({
      round: r,
      key: roundKey(r, total),
      matches: matches.filter((m) => m.round === r).sort((a, b) => a.position - b.position),
    });
  }
  return rounds;
}
