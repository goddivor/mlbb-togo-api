// Pure rewards logic (#122): grant planning, expiry, equip rules, fallback,
// elections and periods. No I/O here so everything is unit testable.

import { weekKey } from '../gamification/gamification.rules';

const DAY = 86_400_000;

export interface FramePeriod {
  from: string;
  to: string | null;
  /** Ended before its term (admin action, champion transfer, MVP override). */
  endedEarly?: boolean;
}

/** Stored state of a `UserFrame` row, as the logic needs it. */
export interface FrameRowState {
  expiresAt: Date | null;
  expiredAt: Date | null;
  timesGranted: number;
  history: FramePeriod[];
}

/** A row is active (wearable) while not expired and not past its expiry. */
export function isFrameRowActive(
  row: Pick<FrameRowState, 'expiresAt' | 'expiredAt'> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!row) return false;
  if (row.expiredAt) return false;
  return !row.expiresAt || row.expiresAt.getTime() > now.getTime();
}

export interface GrantOptions {
  /** Start of the new ownership period (defaults to now). */
  startsAt?: Date;
  /** Lifetime in days (temporary frame); null/undefined = permanent. */
  days?: number | null;
  /**
   * An expired row whose expiry is at most this far before `startsAt` is
   * treated as a continuation (re-election): the period is extended instead
   * of starting a new one.
   */
  continuityGraceMs?: number;
}

export type GrantPlan =
  | { action: 'noop' }
  | { action: 'create'; expiresAt: Date | null; history: FramePeriod[] }
  | {
      action: 'update';
      kind: 'extend' | 'reactivate' | 'make_permanent' | 'renew';
      expiresAt: Date | null;
      history: FramePeriod[];
      timesGranted: number;
    };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Decides what a grant does to the existing row:
 * - no row: create it;
 * - active permanent row, permanent grant: nothing (add-only, idempotent);
 * - active temporary row: extend from `max(expiresAt, startsAt)` by `days`;
 * - expired row: new period (or continuation within the grace window);
 * - temporary row, permanent grant: becomes permanent.
 */
export function planGrant(
  existing: FrameRowState | null,
  opts: GrantOptions,
  now: Date = new Date(),
): GrantPlan {
  const start = opts.startsAt ?? now;
  const days = opts.days && opts.days > 0 ? opts.days : null;
  const permanent = !days;

  if (!existing) {
    const expiresAt = days ? new Date(start.getTime() + days * DAY) : null;
    return { action: 'create', expiresAt, history: [{ from: iso(start)!, to: iso(expiresAt) }] };
  }

  const history = [...(existing.history ?? [])];
  const active = isFrameRowActive(existing, now);
  const grace = opts.continuityGraceMs ?? 0;
  // The grace window only bridges a period that ran to its term: a frame an
  // admin just ended must not be silently extended by a re-election.
  const endedEarly = !active && !!history[history.length - 1]?.endedEarly;
  const continuous =
    active ||
    (!endedEarly && !!existing.expiresAt && existing.expiresAt.getTime() >= start.getTime() - grace);
  const times = (existing.timesGranted ?? 1) + 1;

  if (active && !existing.expiresAt) {
    // Permanent or "until ended" row still worn: nothing to add.
    return { action: 'noop' };
  }

  if (permanent) {
    if (continuous && history.length) {
      history[history.length - 1] = { ...history[history.length - 1], to: null };
    } else {
      history.push({ from: iso(start)!, to: null });
    }
    return {
      action: 'update',
      kind: active ? 'make_permanent' : 'renew',
      expiresAt: null,
      history,
      timesGranted: times,
    };
  }

  if (continuous && existing.expiresAt) {
    const base = Math.max(existing.expiresAt.getTime(), start.getTime());
    const expiresAt = new Date(base + days! * DAY);
    if (history.length) history[history.length - 1] = { ...history[history.length - 1], to: iso(expiresAt) };
    else history.push({ from: iso(start)!, to: iso(expiresAt) });
    return { action: 'update', kind: 'extend', expiresAt, history, timesGranted: times };
  }

  const expiresAt = new Date(start.getTime() + days! * DAY);
  history.push({ from: iso(start)!, to: iso(expiresAt) });
  return { action: 'update', kind: 'reactivate', expiresAt, history, timesGranted: times };
}

/**
 * Closes the current period of a row ended at `at` (natural expiry, or
 * `early` for an admin action / transfer before the term).
 */
export function closeHistory(history: FramePeriod[], at: Date, early = false): FramePeriod[] {
  const out = [...(history ?? [])];
  if (!out.length) return out;
  const last = out[out.length - 1];
  if (!last.to || new Date(last.to).getTime() > at.getTime()) {
    out[out.length - 1] = { ...last, to: at.toISOString(), ...(early ? { endedEarly: true } : {}) };
  }
  return out;
}

export function parseHistory(raw: unknown): FramePeriod[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === 'object' && typeof (p as any).from === 'string')
    .map((p: any) => ({
      from: p.from,
      to: typeof p.to === 'string' ? p.to : null,
      ...(p.endedEarly === true ? { endedEarly: true } : {}),
    }));
}

// ----- Equipped frame -----

export interface EquipState {
  equippedFrame?: string | null;
  fallbackFrame?: string | null;
  equippedFrameExpiresAt?: Date | string | null;
}

/**
 * Frame to display for a user (one query: fields on `User`). A temporary
 * frame past its expiry falls back to the last permanent frame, else to
 * none (rank frame).
 */
export function resolveEquippedFrame(user: EquipState | null | undefined, now: Date = new Date()): string | null {
  if (!user?.equippedFrame) return null;
  const exp = user.equippedFrameExpiresAt ? new Date(user.equippedFrameExpiresAt) : null;
  if (exp && exp.getTime() <= now.getTime()) return user.fallbackFrame || null;
  return user.equippedFrame;
}

export type EquipCheck = 'ok' | 'unknown_frame' | 'not_owned' | 'expired';

export function checkEquip(
  frameExists: boolean,
  row: Pick<FrameRowState, 'expiresAt' | 'expiredAt'> | null,
  now: Date = new Date(),
): EquipCheck {
  if (!frameExists) return 'unknown_frame';
  if (!row) return 'not_owned';
  if (!isFrameRowActive(row, now)) return 'expired';
  return 'ok';
}

/**
 * New equip fields after equipping `key` (null = none). Equipping a
 * permanent frame also records it as the fallback; equipping "none" clears
 * the fallback so an expiring temporary frame returns to the rank frame.
 */
export function nextEquipState(
  current: EquipState,
  key: string | null,
  temporary: boolean,
  expiresAt: Date | null,
): Required<EquipState> {
  if (!key) return { equippedFrame: null, fallbackFrame: null, equippedFrameExpiresAt: null };
  if (temporary) {
    return { equippedFrame: key, fallbackFrame: current.fallbackFrame ?? null, equippedFrameExpiresAt: expiresAt };
  }
  return { equippedFrame: key, fallbackFrame: key, equippedFrameExpiresAt: null };
}

// ----- Periods (Lomé = UTC) -----

/** Monday 00:00 UTC of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const day = d.getUTCDay() || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1)));
}

export function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Previous Monday–Sunday week relative to `now`. */
export function previousWeek(now: Date): { start: Date; end: Date; key: string } {
  const end = startOfWeek(now);
  const start = new Date(end.getTime() - 7 * DAY);
  return { start, end, key: weekKey(start) };
}

/** Previous calendar month relative to `now`. */
export function previousMonth(now: Date): { start: Date; end: Date; key: string } {
  const end = startOfMonth(now);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { start, end, key };
}

/** Parses `2026-W38` into its Monday–Sunday window. */
export function weekWindow(key: string): { start: Date; end: Date; key: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  // ISO week 1 contains January 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const start = new Date(startOfWeek(jan4).getTime() + (week - 1) * 7 * DAY);
  if (weekKey(start) !== key) return null;
  return { start, end: new Date(start.getTime() + 7 * DAY), key };
}

// ----- Elections -----

export interface MvpCandidate {
  userId: string;
  mvps: number;
  wins: number;
  firstMvpAt: Date;
}

/**
 * Weekly MVP: most `match_mvp` events in the week; ties → most wins, then
 * earliest MVP. Nobody when no official match was played that week.
 */
export function electWeeklyMvp(candidates: MvpCandidate[], officialMatches: number): string | null {
  if (officialMatches < 1) return null;
  const ranked = candidates
    .filter((c) => c.mvps > 0)
    .sort(
      (a, b) =>
        b.mvps - a.mvps ||
        b.wins - a.wins ||
        a.firstMvpAt.getTime() - b.firstMvpAt.getTime() ||
        a.userId.localeCompare(b.userId),
    );
  return ranked[0]?.userId ?? null;
}

export interface XpCandidate {
  userId: string;
  xp: number;
  /** Time of the last XP event in the window (reached the total first wins). */
  lastAt: Date;
}

/** Monthly number one: highest XP gained in the month; ties → reached first. */
export function electMonthlyNumberOne(candidates: XpCandidate[]): string | null {
  const ranked = candidates
    .filter((c) => c.xp > 0)
    .sort((a, b) => b.xp - a.xp || a.lastAt.getTime() - b.lastAt.getTime() || a.userId.localeCompare(b.userId));
  return ranked[0]?.userId ?? null;
}

// ----- Level catch-up -----

/** Level frame ids the user should own at `level` but does not. */
export function missingLevelFrames(levelFrameIds: string[], owned: Iterable<string>): string[] {
  const have = new Set(owned);
  return levelFrameIds.filter((id) => !have.has(id));
}
