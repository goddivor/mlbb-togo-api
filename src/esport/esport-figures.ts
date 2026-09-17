import { BadRequestException } from '@nestjs/common';

/** Public target figures displayed on the About page (animated counters). */
export interface EsportFigures {
  /** Cumulated stream audience target (viewers). */
  streamAudience: number;
  /** Social networks reach target (people). */
  socialReach: number;
  /** Number of teams (community + esport) target. */
  teams: number;
  /** Offline events (LAN, meetups) target. */
  offlineEvents: number;
}

export const FIGURE_KEYS: (keyof EsportFigures)[] = [
  'streamAudience',
  'socialReach',
  'teams',
  'offlineEvents',
];

export const DEFAULT_FIGURES: EsportFigures = {
  streamAudience: 50000,
  socialReach: 100000,
  teams: 32,
  offlineEvents: 12,
};

const MAX_FIGURE = 1_000_000_000;

/**
 * Parse the JSON stored in `Esport.figures`. Missing or corrupt values fall
 * back to the defaults so the public endpoint never fails.
 */
export function parseFigures(raw: string | null | undefined): EsportFigures {
  if (!raw) return { ...DEFAULT_FIGURES };
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_FIGURES };
  }
  if (!obj || typeof obj !== 'object') return { ...DEFAULT_FIGURES };
  const out = { ...DEFAULT_FIGURES };
  for (const key of FIGURE_KEYS) {
    const v = Number(obj[key]);
    if (Number.isFinite(v) && v >= 0) out[key] = Math.round(v);
  }
  return out;
}

/**
 * Validate an admin payload and return the JSON string to persist.
 * Only known keys are kept; every key must be a non-negative integer.
 */
export function normalizeFiguresInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Les chiffres doivent être un objet.');
  const body = input as Record<string, unknown>;
  const out = { ...DEFAULT_FIGURES };
  for (const key of FIGURE_KEYS) {
    if (body[key] == null || body[key] === '') continue;
    const v = Number(body[key]);
    if (!Number.isFinite(v) || v < 0 || v > MAX_FIGURE)
      throw new BadRequestException(`Valeur invalide pour « ${key} ».`);
    out[key] = Math.round(v);
  }
  return JSON.stringify(out);
}
