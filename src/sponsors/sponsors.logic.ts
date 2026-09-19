import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_TIER,
  REQUEST_STATUSES,
  RequestStatus,
  SPONSOR_TIERS,
  SponsorTier,
} from './sponsors.constants';

const OBJECT_ID = /^[a-f\d]{24}$/i;

export type SponsorRecord = {
  id: string;
  name: string | null;
  logo: string;
  url: string | null;
  sort: number;
  tier?: string | null;
  description?: string | null;
  seasonIds?: string[] | null;
  isActive?: boolean | null;
  createdAt?: Date;
};

export function isTier(value: unknown): value is SponsorTier {
  return typeof value === 'string' && (SPONSOR_TIERS as readonly string[]).includes(value);
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value);
}

/** Public shape of a sponsor: legacy rows get a tier and are active. */
export function serializeSponsor(s: SponsorRecord) {
  return {
    id: s.id,
    name: s.name ?? null,
    logo: s.logo,
    url: s.url ?? null,
    website: s.url ?? null,
    sort: s.sort ?? 0,
    tier: isTier(s.tier) ? s.tier : DEFAULT_TIER,
    description: s.description ?? null,
    seasonIds: Array.isArray(s.seasonIds) ? s.seasonIds : [],
    isActive: s.isActive !== false,
    createdAt: s.createdAt ?? null,
  };
}

export type SerializedSponsor = ReturnType<typeof serializeSponsor>;

/** Active sponsors of a season: linked to it, or linked to no season at all. */
export function filterForSeason(sponsors: SponsorRecord[], seasonId: string | null): SerializedSponsor[] {
  return sponsors
    .map(serializeSponsor)
    .filter((s) => s.isActive)
    .filter((s) => !seasonId || s.seasonIds.length === 0 || s.seasonIds.includes(seasonId))
    .sort(compareSponsors);
}

/** Tier rank first (title before partner), then `sort`, then name. */
export function compareSponsors(a: SerializedSponsor, b: SerializedSponsor) {
  const ta = SPONSOR_TIERS.indexOf(a.tier);
  const tb = SPONSOR_TIERS.indexOf(b.tier);
  if (ta !== tb) return ta - tb;
  if (a.sort !== b.sort) return a.sort - b.sort;
  return (a.name ?? '').localeCompare(b.name ?? '');
}

export function groupByTier(sponsors: SerializedSponsor[]): Record<SponsorTier, SerializedSponsor[]> {
  const out = { title: [], gold: [], silver: [], partner: [] } as Record<SponsorTier, SerializedSponsor[]>;
  for (const s of sponsors) out[s.tier].push(s);
  return out;
}

/**
 * Validate an admin sponsor payload. With `partial` (PATCH) only the keys
 * present are returned; otherwise the logo is required.
 */
export function normalizeSponsorInput(input: unknown, partial: boolean) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Corps de requête invalide.');
  const body = input as Record<string, unknown>;
  const out: {
    name?: string | null;
    logo?: string;
    url?: string | null;
    sort?: number;
    tier?: string | null;
    description?: string | null;
    seasonIds?: string[];
    isActive?: boolean;
  } = {};

  if (body.logo !== undefined) {
    const logo = String(body.logo ?? '').trim();
    if (!logo) throw new BadRequestException('Le logo du sponsor est requis.');
    out.logo = logo;
  } else if (!partial) {
    throw new BadRequestException('Le logo du sponsor est requis.');
  }
  if (body.name !== undefined) out.name = body.name == null ? null : String(body.name).trim() || null;
  const url = body.url !== undefined ? body.url : body.website;
  if (url !== undefined) out.url = url == null ? null : String(url).trim() || null;
  if (body.description !== undefined)
    out.description = body.description == null ? null : String(body.description).trim().slice(0, 600) || null;
  if (body.sort !== undefined) {
    const n = Number(body.sort);
    if (!Number.isFinite(n)) throw new BadRequestException('Ordre invalide.');
    out.sort = Math.round(n);
  }
  if (body.tier !== undefined) {
    if (body.tier == null || body.tier === '') out.tier = null;
    else if (!isTier(body.tier))
      throw new BadRequestException(`Niveau invalide. Valeurs : ${SPONSOR_TIERS.join(', ')}.`);
    else out.tier = body.tier;
  }
  if (body.seasonIds !== undefined) {
    if (!Array.isArray(body.seasonIds)) throw new BadRequestException('seasonIds doit être une liste.');
    const ids = body.seasonIds.map((v) => String(v).trim());
    if (ids.some((id) => !OBJECT_ID.test(id))) throw new BadRequestException('Identifiant de saison invalide.');
    out.seasonIds = Array.from(new Set(ids));
  }
  if (body.isActive !== undefined) out.isActive = body.isActive === true || body.isActive === 'true';
  return out;
}

/** Offer as stored: `benefits` is a JSON string. */
export type OfferRecord = {
  id: string;
  name: string;
  tier?: string | null;
  priceLabel?: string | null;
  benefits: string;
  highlight: boolean;
  isActive?: boolean | null;
  sort: number;
  createdAt?: Date;
  updatedAt?: Date;
};

export function parseBenefits(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((b) => typeof b === 'string') : [];
  } catch {
    return [];
  }
}

export function serializeOffer(o: OfferRecord) {
  return {
    id: o.id,
    name: o.name,
    tier: isTier(o.tier) ? o.tier : null,
    priceLabel: o.priceLabel ?? null,
    benefits: parseBenefits(o.benefits),
    highlight: !!o.highlight,
    isActive: o.isActive !== false,
    sort: o.sort ?? 0,
    createdAt: o.createdAt ?? null,
    updatedAt: o.updatedAt ?? null,
  };
}

/** Sort offers by `sort` then name; drops inactive ones unless `includeInactive`. */
export function sortOffers<T extends { sort: number; name: string; isActive: boolean }>(
  offers: T[],
  includeInactive = false,
): T[] {
  return offers
    .filter((o) => includeInactive || o.isActive)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

/**
 * Sliding-window rate limiter kept in memory (per process). Good enough for
 * a low-traffic public form; entries expire lazily.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit and tells whether it is allowed. */
  hit(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(now);
    return true;
  }

  private prune(now: number) {
    const since = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (!times.some((t) => t > since)) this.hits.delete(key);
    }
  }
}

/** Client IP behind a reverse proxy (first X-Forwarded-For entry) or socket IP. */
export function clientIp(req: { headers?: Record<string, any>; ip?: string; socket?: { remoteAddress?: string } }): string {
  const fwd = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : typeof fwd === 'string' ? fwd.split(',')[0] : '';
  return (first || req.ip || req.socket?.remoteAddress || 'unknown').trim();
}
