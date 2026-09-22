// Pure rules of the image uploads (#131): purposes and who may upload them,
// Cloudinary signatures, upload validation and delivery URLs. Kept free of
// Nest/Prisma so every rule is unit tested without a database or network.

import * as crypto from 'crypto';
import { PermissionSubject, hasAnyPermission } from '../access/permissions';

export const MEDIA_PURPOSES = [
  'avatar',
  'team',
  'team-staff',
  'sponsor',
  'tournament',
  'season',
  'award',
  'match',
] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export const MEDIA_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/**
 * Internal status of a row recorded at sign time, before the browser uploads
 * the file. `confirm` promotes it; the daily cron sweeps the ones never
 * confirmed. Never listed in the media library.
 */
export const SIGNED_STATUS = 'signed';

export type TargetType =
  | 'user'
  | 'esportTeam'
  | 'esportTeamStaff'
  | 'sponsor'
  | 'tournament'
  | 'season'
  | 'award'
  | 'match';

export interface PurposeDef {
  targetType: TargetType;
  /**
   * `single`: the image IS the target field (attached server-side on upload,
   * replacing and destroying the previous tracked asset).
   * `list`: the image is one entry of a list saved by the caller's form
   * (match screenshots): never attached automatically.
   */
  kind: 'single' | 'list';
  /** A target id is mandatory (avatar: the user himself). */
  targetRequired: boolean;
  /** The field can be emptied (a sponsor always needs a logo). */
  removable: boolean;
  /** Longest side of the delivered image (c_limit). */
  maxDimension: number;
  /** Permissions allowing an upload that is approved right away. */
  permissions: readonly string[];
}

export const PURPOSES: Record<MediaPurpose, PurposeDef> = {
  avatar: {
    targetType: 'user',
    kind: 'single',
    targetRequired: true,
    removable: true,
    maxDimension: 400,
    permissions: ['admin.users'],
  },
  team: {
    targetType: 'esportTeam',
    kind: 'single',
    targetRequired: false,
    removable: true,
    maxDimension: 512,
    // admin.requests creates community teams from player requests.
    permissions: ['admin.esport', 'admin.requests'],
  },
  'team-staff': {
    targetType: 'esportTeamStaff',
    kind: 'single',
    targetRequired: false,
    removable: true,
    maxDimension: 400,
    permissions: ['admin.esport'],
  },
  sponsor: {
    targetType: 'sponsor',
    kind: 'single',
    targetRequired: false,
    removable: false,
    maxDimension: 600,
    permissions: ['sponsors.manage'],
  },
  tournament: {
    targetType: 'tournament',
    kind: 'single',
    targetRequired: false,
    removable: true,
    maxDimension: 1920,
    permissions: ['admin.tournaments'],
  },
  season: {
    targetType: 'season',
    kind: 'single',
    targetRequired: false,
    removable: true,
    maxDimension: 1920,
    permissions: ['admin.seasons'],
  },
  award: {
    targetType: 'award',
    kind: 'single',
    targetRequired: false,
    removable: true,
    maxDimension: 1024,
    permissions: ['admin.awards'],
  },
  match: {
    targetType: 'match',
    kind: 'list',
    targetRequired: true,
    removable: false,
    maxDimension: 1920,
    permissions: ['admin.matches', 'matches.validate'],
  },
};

export function isMediaPurpose(value: unknown): value is MediaPurpose {
  return typeof value === 'string' && (MEDIA_PURPOSES as readonly string[]).includes(value);
}

export function isMediaStatus(value: unknown): value is MediaStatus {
  return typeof value === 'string' && (MEDIA_STATUSES as readonly string[]).includes(value);
}

// ----- limits ---------------------------------------------------------------

/** Formats accepted by Cloudinary (`allowed_formats`) and re-checked on confirm. */
export const ALLOWED_FORMATS = ['jpg', 'png', 'webp', 'gif'] as const;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_DIMENSION = 6000;
export const MIN_SOURCE_DIMENSION = 16;
/** Cloudinary refuses a signed upload whose timestamp is older than 1 hour. */
export const SIGNATURE_TTL_SECONDS = 3600;
/** A signed upload not confirmed after this delay is abandoned (swept by the cron). */
export const ABANDONED_UPLOAD_MS = 24 * 3600 * 1000;
/** Signed but not yet confirmed uploads one user may have open within the signature TTL. */
export const MAX_OPEN_SIGNATURES = 20;

// ----- permissions ------------------------------------------------------------

export interface UploadActor extends PermissionSubject {
  id: string;
}

/** Facts about the target the permission rule needs (looked up by the service). */
export interface TargetFacts {
  /** The actor is the captain of the target team (`team` purpose). */
  isCaptain?: boolean;
  /** Type of the target team: `community` | `esport`. */
  teamType?: string | null;
}

export type UploadDecision =
  | { allowed: true; status: 'approved' | 'pending' }
  | { allowed: false; reason: string };

/**
 * Who may upload what:
 * - avatar: the user himself, or `admin.users`;
 * - team logo: `admin.esport` (or `admin.requests` when creating a team), or
 *   the team captain; a captain's image of a COMMUNITY team stays pending
 *   until an admin approves it;
 * - everything else: the admins holding the matching permission.
 */
export function decideUpload(
  purpose: MediaPurpose,
  actor: UploadActor,
  targetId: string | null,
  facts: TargetFacts = {},
): UploadDecision {
  const def = PURPOSES[purpose];
  if (def.targetRequired && !targetId) return { allowed: false, reason: 'target_required' };
  if (purpose === 'avatar' && targetId === actor.id) return { allowed: true, status: 'approved' };
  if (purpose === 'team') {
    // Editing an existing team is admin.esport's job; admin.requests only
    // uploads the logo of a team it is creating.
    const adminPerms = targetId ? ['admin.esport'] : def.permissions;
    if (hasAnyPermission(actor, adminPerms)) return { allowed: true, status: 'approved' };
    if (targetId && facts.isCaptain) {
      return { allowed: true, status: facts.teamType === 'esport' ? 'approved' : 'pending' };
    }
    return { allowed: false, reason: 'forbidden' };
  }
  if (hasAnyPermission(actor, def.permissions)) return { allowed: true, status: 'approved' };
  return { allowed: false, reason: 'forbidden' };
}

/** Admins of a purpose may paste an external URL instead of uploading. */
export function canPasteUrl(purpose: MediaPurpose, actor: PermissionSubject): boolean {
  return hasAnyPermission(actor, PURPOSES[purpose].permissions);
}

// ----- public ids -------------------------------------------------------------

/** `folder` normalised to `a/b/` (or '' when unset). */
export function folderPrefix(folder: string | null | undefined): string {
  const clean = (folder ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  return clean ? `${clean}/` : '';
}

/** Prefix every public id of an upload slot starts with. */
export function slotPrefix(
  folder: string | null | undefined,
  purpose: MediaPurpose,
  targetId: string | null,
  userId: string,
): string {
  return `${folderPrefix(folder)}${purpose}/${targetId ?? 'new'}/${userId}_`;
}

/** Fresh public id for a signed upload (the client cannot choose it). */
export function buildPublicId(
  folder: string | null | undefined,
  purpose: MediaPurpose,
  targetId: string | null,
  userId: string,
  random: string = crypto.randomBytes(8).toString('hex'),
): string {
  return `${slotPrefix(folder, purpose, targetId, userId)}${random}`;
}

/** Ids we accept in public ids and path segments (Mongo ids, 'new', hex). */
export function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Public id of a Cloudinary delivery URL (`.../image/upload/<transfos>/v123/<id>.<ext>`),
 * or null for any other URL (MLBB CDN, external sites...).
 */
export function publicIdFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/image\/upload\/(?:.*?\/)?v\d+\/(.+?)(?:\.[A-Za-z0-9]+)?(?:[?#].*)?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * True when `url` is a Cloudinary delivery URL of an avatar uploaded for
 * `userId` through the media flow (public id `[<folder>/]avatar/<userId>/<uploaderId>_<random>`).
 * Only the shape is checked here: whether the asset is tracked is checked
 * against the database before such a URL is ever written.
 */
export function isUploadedAvatarUrl(url: string | null | undefined, userId: string | null | undefined): boolean {
  if (!userId || !isSafeSegment(userId)) return false;
  const publicId = publicIdFromUrl(url);
  if (!publicId) return false;
  return new RegExp(`(?:^|/)avatar/${userId}/[A-Za-z0-9-]+_[A-Za-z0-9]+$`).test(publicId);
}

// ----- signatures ---------------------------------------------------------------

type SignParams = Record<string, string | number | boolean | undefined | null>;

/**
 * Cloudinary request signature: parameters sorted by name, `k=v` joined with
 * `&`, api secret appended, SHA-1 hex. `file`, `cloud_name`, `resource_type`
 * and `api_key` are never signed; empty values are skipped.
 */
export function cloudinarySignature(params: SignParams, apiSecret: string): string {
  const excluded = new Set(['file', 'cloud_name', 'resource_type', 'api_key', 'signature']);
  const payload = Object.keys(params)
    .filter((k) => !excluded.has(k) && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(payload + apiSecret).digest('hex');
}

export interface UploadTicket {
  uploadUrl: string;
  cloudName: string;
  apiKey: string;
  /** Signed fields the browser must send unchanged with the file. */
  params: {
    public_id: string;
    timestamp: number;
    allowed_formats: string;
    overwrite: string;
    signature: string;
  };
  maxBytes: number;
  formats: readonly string[];
  expiresAt: string;
}

export function buildUploadTicket(opts: {
  apiBase: string;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  publicId: string;
  nowSeconds: number;
}): UploadTicket {
  const signed = {
    allowed_formats: ALLOWED_FORMATS.join(','),
    // Signed uploads overwrite by default: without this, replaying the ticket
    // (valid for an hour) would swap the bytes of an asset already validated,
    // or approved by a moderator, behind the API's back.
    overwrite: 'false',
    public_id: opts.publicId,
    timestamp: opts.nowSeconds,
  };
  return {
    uploadUrl: `${opts.apiBase.replace(/\/+$/, '')}/v1_1/${encodeURIComponent(opts.cloudName)}/image/upload`,
    cloudName: opts.cloudName,
    apiKey: opts.apiKey,
    params: { ...signed, signature: cloudinarySignature(signed, opts.apiSecret) },
    maxBytes: MAX_UPLOAD_BYTES,
    formats: ALLOWED_FORMATS,
    expiresAt: new Date((opts.nowSeconds + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
  };
}

// ----- validation --------------------------------------------------------------

/** Subset of the Cloudinary Admin API resource used for validation. */
export interface CloudinaryResource {
  public_id: string;
  format: string;
  resource_type: string;
  type: string;
  bytes: number;
  width: number;
  height: number;
  version?: number;
  secure_url: string;
  /** Frame count (returned with `pages=true`): > 1 for an animated GIF/WebP. */
  pages?: number;
}

export type ValidationError =
  | 'wrong_slot'
  | 'not_image'
  | 'format'
  | 'too_large'
  | 'dimensions'
  | 'animated';

/**
 * Checks the AUTHORITATIVE metadata read from the Cloudinary Admin API (not
 * values reported by the browser): slot, type, format, size, dimensions and
 * animation.
 */
export function validateResource(resource: CloudinaryResource, expectedPrefix: string): ValidationError | null {
  if (!resource.public_id.startsWith(expectedPrefix)) return 'wrong_slot';
  if (resource.resource_type !== 'image' || resource.type !== 'upload') return 'not_image';
  if (!(ALLOWED_FORMATS as readonly string[]).includes(String(resource.format).toLowerCase())) return 'format';
  if (!(resource.bytes > 0) || resource.bytes > MAX_UPLOAD_BYTES) return 'too_large';
  const { width, height } = resource;
  if (
    !(width >= MIN_SOURCE_DIMENSION && height >= MIN_SOURCE_DIMENSION) ||
    width > MAX_SOURCE_DIMENSION ||
    height > MAX_SOURCE_DIMENSION
  ) {
    return 'dimensions';
  }
  if ((resource.pages ?? 1) > 1) return 'animated';
  return null;
}

export const VALIDATION_MESSAGES: Record<ValidationError, string> = {
  wrong_slot: 'Image non reconnue pour cet emplacement.',
  not_image: 'Le fichier envoyé n’est pas une image.',
  format: `Format refusé (formats acceptés : ${ALLOWED_FORMATS.join(', ')}).`,
  too_large: `Image trop lourde (maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} Mo).`,
  dimensions: `Dimensions invalides (entre ${MIN_SOURCE_DIMENSION} et ${MAX_SOURCE_DIMENSION} pixels de côté).`,
  animated: 'Les images animées ne sont pas acceptées.',
};

// ----- delivery ----------------------------------------------------------------

/**
 * Delivered URL: the original secure URL with a size limit and automatic
 * format / quality (`c_limit,w_N,h_N/f_auto,q_auto`) inserted after `/upload/`.
 */
export function deliveryUrl(secureUrl: string, maxDimension: number): string {
  const transformation = `c_limit,w_${maxDimension},h_${maxDimension}/f_auto,q_auto`;
  return secureUrl.replace('/image/upload/', `/image/upload/${transformation}/`);
}
