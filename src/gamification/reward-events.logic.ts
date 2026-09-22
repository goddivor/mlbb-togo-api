// Reward events (catalogue §6.5, rewards #125): admin-managed windows with
// conditions and rewards. Pure logic only (parsing, validation, widening
// rule, progress, default editions) so it is unit tested without I/O.

const DAY = 86_400_000;

export const EVENT_CONDITION_TYPES = [
  'daily_login',
  'forum_post',
  'comment_posted',
  'match_played',
  'match_win',
  'bracket_played',
  'bracket_win',
  'tournament_registration',
  'event_joined',
  'stream_watch',
  'pickban_completed',
  'account_created_before',
] as const;
export type EventConditionType = (typeof EVENT_CONDITION_TYPES)[number];

/** Condition types whose `scope` (tournament / event id) is mandatory. */
export const SCOPE_REQUIRED: readonly EventConditionType[] = ['bracket_played'];
/** Condition types that accept a scope. */
export const SCOPED: readonly EventConditionType[] = ['bracket_played', 'bracket_win', 'tournament_registration', 'event_joined'];

export const EVENT_STATUSES = ['draft', 'scheduled', 'active', 'closed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type ConditionMode = 'all' | 'any';

export interface EventCondition {
  type: EventConditionType;
  count: number;
  scope: string | null;
}

export interface EventConditions {
  mode: ConditionMode;
  items: EventCondition[];
}

export interface EventRewards {
  achievementId: string | null;
  frameId: string | null;
  /** Frame lifetime in days; null = permanent (or catalogue default). */
  frameDays: number | null;
  xp: number;
}

export interface EventWindow {
  startsAt: Date;
  endsAt: Date;
  status: string;
}

export interface EventShape extends EventWindow {
  conditions: EventConditions;
  rewards: EventRewards;
}

const isType = (t: unknown): t is EventConditionType =>
  typeof t === 'string' && (EVENT_CONDITION_TYPES as readonly string[]).includes(t);

/** Normalises one condition (count >= 1, scope only where it makes sense). */
export function normalizeCondition(raw: any): EventCondition | null {
  if (!raw || !isType(raw.type)) return null;
  const count = raw.type === 'account_created_before' ? 1 : Math.max(1, Math.trunc(Number(raw.count) || 1));
  const scope =
    SCOPED.includes(raw.type) && typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim() : null;
  return { type: raw.type, count, scope };
}

/**
 * Stored conditions: either a legacy array (all required) or
 * `{ mode, items }`. Unknown entries are dropped.
 */
export function parseConditions(raw: unknown): EventConditions {
  const obj = raw as any;
  const list: unknown[] = Array.isArray(obj) ? obj : Array.isArray(obj?.items) ? obj.items : [];
  const mode: ConditionMode = !Array.isArray(obj) && obj?.mode === 'any' ? 'any' : 'all';
  return { mode, items: list.map(normalizeCondition).filter((c): c is EventCondition => !!c) };
}

export function parseRewards(raw: unknown): EventRewards {
  const r = (raw ?? {}) as any;
  const days = Number(r.frameDays);
  return {
    achievementId: typeof r.achievementId === 'string' && r.achievementId ? r.achievementId : null,
    frameId: typeof r.frameId === 'string' && r.frameId ? r.frameId : null,
    frameDays: Number.isFinite(days) && days > 0 ? Math.trunc(days) : null,
    xp: Math.max(0, Math.trunc(Number(r.xp) || 0)),
  };
}

/** Validation errors of an event (French messages, shown to admins). */
export function validateEvent(
  e: EventShape,
  known: { achievement: (id: string) => boolean; frame: (id: string) => boolean },
  publishing = true,
): string[] {
  const errors: string[] = [];
  if (!(e.startsAt instanceof Date) || Number.isNaN(e.startsAt.getTime())) errors.push('Date de début invalide.');
  if (!(e.endsAt instanceof Date) || Number.isNaN(e.endsAt.getTime())) errors.push('Date de fin invalide.');
  if (!errors.length && e.endsAt.getTime() <= e.startsAt.getTime()) errors.push('La fin doit suivre le début.');
  if (!e.conditions.items.length) errors.push('Au moins une condition est requise.');
  for (const c of e.conditions.items) {
    // Drafts may wait for their tournament; a published event may not.
    if (publishing && SCOPE_REQUIRED.includes(c.type) && !c.scope) errors.push(`La condition « ${c.type} » demande un tournoi.`);
  }
  const keys = e.conditions.items.map(conditionKey);
  if (new Set(keys).size !== keys.length) errors.push('Condition en double.');
  const r = e.rewards;
  if (!r.achievementId && !r.frameId && !r.xp) errors.push('Au moins une récompense est requise.');
  if (r.achievementId && !known.achievement(r.achievementId)) errors.push('Succès inconnu.');
  if (r.frameId && !known.frame(r.frameId)) errors.push('Cadre inconnu.');
  return errors;
}

export function conditionKey(c: Pick<EventCondition, 'type' | 'scope'>) {
  return `${c.type}:${c.scope ?? ''}`;
}

/** The window has started and the event is published and not closed. */
export function isWindowOpen(e: EventWindow, now: Date = new Date()): boolean {
  return (e.status === 'scheduled' || e.status === 'active') && e.startsAt.getTime() <= now.getTime();
}

/** Events currently evaluated on XP events (inside the window). */
export function isEvaluating(e: EventWindow, now: Date = new Date()): boolean {
  return isWindowOpen(e, now) && now.getTime() < e.endsAt.getTime();
}

/** Status the daily job should move a published event to. */
export function nextStatus(e: EventWindow, now: Date = new Date()): EventStatus | null {
  if (e.status !== 'scheduled' && e.status !== 'active') return null;
  if (now.getTime() >= e.endsAt.getTime()) return 'closed';
  if (now.getTime() >= e.startsAt.getTime()) return e.status === 'active' ? null : 'active';
  return e.status === 'scheduled' ? null : 'scheduled';
}

/**
 * Editing an open window may only widen it (catalogue §6.5): earlier or same
 * start, later or same end, same conditions with lower or equal counts,
 * `all` → `any` allowed, rewards may only grow. Returns the violations.
 */
export function wideningViolations(prev: EventShape, next: EventShape): string[] {
  const out: string[] = [];
  if (next.startsAt.getTime() > prev.startsAt.getTime()) out.push('Le début ne peut pas être repoussé.');
  if (next.endsAt.getTime() < prev.endsAt.getTime()) out.push('La fin ne peut pas être avancée.');
  if (prev.conditions.mode === 'any' && next.conditions.mode === 'all') out.push('Le mode ne peut pas passer à « toutes ».');
  const before = new Map(prev.conditions.items.map((c) => [conditionKey(c), c]));
  const after = new Map(next.conditions.items.map((c) => [conditionKey(c), c]));
  const orMode = next.conditions.mode === 'any';
  for (const [key, c] of after) {
    const old = before.get(key);
    // A new alternative widens an `any` event; a new requirement narrows an `all` one.
    if (!old) {
      if (!orMode) out.push(`Nouvelle condition interdite : ${c.type}.`);
      continue;
    }
    if (c.count > old.count) out.push(`Le seuil de « ${c.type} » ne peut pas augmenter.`);
  }
  for (const [key, c] of before) {
    // Removing a requirement widens an `all` event; removing an alternative narrows an `any` one.
    if (!after.has(key) && prev.conditions.mode === 'any') out.push(`Condition retirée interdite : ${c.type}.`);
  }
  const pr = prev.rewards;
  const nr = next.rewards;
  if (pr.achievementId !== nr.achievementId) out.push('Le succès ne peut pas changer.');
  if (pr.frameId !== nr.frameId) out.push('Le cadre ne peut pas changer.');
  if (nr.xp < pr.xp) out.push('Le bonus d’XP ne peut pas baisser.');
  if (pr.frameDays === null && nr.frameDays !== null) out.push('Un cadre permanent ne peut pas devenir temporaire.');
  if (pr.frameDays !== null && nr.frameDays !== null && nr.frameDays < pr.frameDays)
    out.push('La durée du cadre ne peut pas baisser.');
  return out;
}

export interface ConditionProgress extends EventCondition {
  progress: number;
  done: boolean;
}

export function withProgress(items: EventCondition[], values: number[]): ConditionProgress[] {
  return items.map((c, i) => {
    const progress = Math.min(c.count, Math.max(0, values[i] ?? 0));
    return { ...c, progress, done: progress >= c.count };
  });
}

export function isQualified(mode: ConditionMode, progress: ConditionProgress[]): boolean {
  if (!progress.length) return false;
  return mode === 'any' ? progress.some((p) => p.done) : progress.every((p) => p.done);
}

/** XP event types (and refId filter) counted by a condition. */
export function refFilter(c: EventCondition): { startsWith?: string[]; equals?: string[] } | null {
  if (!c.scope) return null;
  switch (c.type) {
    case 'bracket_played':
    case 'bracket_win':
      return { startsWith: [`bracket:${c.scope}:`, `bracket:draft:${c.scope}:`] };
    case 'tournament_registration':
      return { equals: [c.scope, `draft:${c.scope}`] };
    case 'event_joined':
      return { equals: [c.scope] };
    default:
      return null;
  }
}

/** Same date one year later (29/02 → 28/02). */
export function addYear(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + 1);
  if (out.getUTCDate() !== d.getUTCDate()) out.setUTCDate(0);
  return out;
}

/** Slug of the next yearly edition: `rainy_season_2027` → `rainy_season_2028`. */
export function nextEditionSlug(slug: string, startsAt: Date): string {
  const year = addYear(startsAt).getUTCFullYear();
  const m = /^(.*)_(\d{4})$/.exec(slug);
  return `${m ? m[1] : slug}_${year}`;
}

export interface DefaultEvent {
  slug: string;
  name: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
  recurrence: 'none' | 'yearly';
  conditions: EventConditions;
  rewards: EventRewards;
}

/** Next occurrence (UTC) of a yearly window starting on month/day. */
function nextWindow(now: Date, month: number, day: number, lengthDays: number) {
  let year = now.getUTCFullYear();
  let start = new Date(Date.UTC(year, month - 1, day));
  if (start.getTime() + lengthDays * DAY <= now.getTime()) {
    year += 1;
    start = new Date(Date.UTC(year, month - 1, day));
  }
  return { start, end: new Date(start.getTime() + lengthDays * DAY), year };
}

const cond = (type: EventConditionType, count = 1, scope: string | null = null): EventCondition => ({ type, count, scope });
const rewards = (achievementId: string, frameId: string, frameDays: number | null = null): EventRewards => ({
  achievementId,
  frameId,
  frameDays,
  xp: 0,
});

/**
 * Default events of catalogue §6.5, seeded as drafts (dates editable by the
 * admin). `launch` is the platform launch day (anniversary week and
 * pioneers window).
 */
export function defaultEvents(now: Date, launch: Date): DefaultEvent[] {
  const indep = nextWindow(now, 4, 27, 1);
  const cup = nextWindow(now, 4, 20, 14);
  const rain = nextWindow(now, 6, 15, 30);
  const harm = nextWindow(now, 12, 15, 31);
  const lights = nextWindow(now, 12, 24, 9);
  const anniv = nextWindow(now, launch.getUTCMonth() + 1, launch.getUTCDate(), 7);
  const pioneersEnd = new Date(Math.max(now.getTime(), launch.getTime()) + 90 * DAY);
  return [
    {
      slug: `independence_day_${indep.year}`,
      name: '27 Avril',
      description: 'Connecte-toi le jour de la fête de l’Indépendance du Togo.',
      startsAt: indep.start,
      endsAt: indep.end,
      recurrence: 'yearly',
      conditions: { mode: 'all', items: [cond('daily_login')] },
      rewards: rewards('independence_day', 'independance'),
    },
    {
      slug: `independence_cup_${cup.year}`,
      name: 'Coupe de l’Indépendance',
      description: 'Dispute au moins un match de bracket dans la coupe de l’Indépendance.',
      startsAt: cup.start,
      endsAt: cup.end,
      recurrence: 'yearly',
      // The tournament (scope) is chosen by the admin before publishing.
      conditions: { mode: 'all', items: [cond('bracket_played')] },
      rewards: rewards('independence_cup', 'coupe_independance', 30),
    },
    {
      slug: `rainy_season_${rain.year}`,
      name: 'Saison des pluies',
      description: 'Reste fidèle pendant la saison des pluies : 10 connexions.',
      startsAt: rain.start,
      endsAt: rain.end,
      recurrence: 'yearly',
      conditions: { mode: 'all', items: [cond('daily_login', 10)] },
      rewards: rewards('rainy_season', 'saison_pluies'),
    },
    {
      slug: `harmattan_${harm.year}`,
      name: 'Harmattan',
      description: 'Souffle de l’harmattan : 5 connexions ou participation à l’événement dédié.',
      startsAt: harm.start,
      endsAt: harm.end,
      recurrence: 'yearly',
      conditions: { mode: 'any', items: [cond('daily_login', 5), cond('event_joined')] },
      rewards: rewards('harmattan', 'harmattan'),
    },
    {
      slug: `year_end_lights_${lights.year}`,
      name: 'Fêtes de fin d’année',
      description: 'Fête la fin d’année avec la communauté : 5 connexions.',
      startsAt: lights.start,
      endsAt: lights.end,
      recurrence: 'yearly',
      conditions: { mode: 'all', items: [cond('daily_login', 5)] },
      rewards: rewards('year_end_lights', 'lanternes', 14),
    },
    {
      slug: `site_anniversary_${anniv.year}`,
      name: 'Anniversaire',
      description: 'Sois présent pendant la semaine d’anniversaire de la plateforme.',
      startsAt: anniv.start,
      endsAt: anniv.end,
      recurrence: 'yearly',
      conditions: { mode: 'all', items: [cond('daily_login')] },
      rewards: rewards('site_anniversary', 'anniversaire'),
    },
    {
      slug: 'pioneers',
      name: 'Pionniers',
      description: 'Les premiers membres de la plateforme, inscrits avant la date de coupure.',
      startsAt: launch,
      endsAt: pioneersEnd,
      recurrence: 'none',
      conditions: { mode: 'all', items: [cond('account_created_before')] },
      rewards: rewards('pioneer', 'fondateur'),
    },
  ];
}
