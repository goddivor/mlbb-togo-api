import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

// Moonton upstream hosts, called directly (no third-party proxy).
// SG_BASE: account flow (sendVc/login/logout/getBaseInfo), form POSTs.
// ACT_BASE: actgateway battle reports (battlereport/*), GETs with query params.
export const SG_BASE = 'https://sg-api.mobilelegends.com';
export const ACT_BASE = 'https://app.web.moontontech.com/actgateway';
// Required by getBaseInfo (Moonton "academy" app).
export const MLBB_X_ACTID = '2728785';
export const MLBB_X_APPID = '2713644';
export const MLBB_ORIGIN = 'https://www.mobilelegends.com';
export const MLBB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const TIMEOUT_MS = 12_000;

/**
 * Outcome of a Moonton call, independent of the HTTP status (Moonton answers
 * most errors with HTTP 200 and a non-zero `code`):
 * - ok: `code === 0`
 * - token_expired: the player session is refused (bad/expired JWT)
 * - offline: Moonton decommissioned the route (`10407`, "接口下线")
 * - error: any other non-zero code or unexpected body
 * - unreachable: network failure, timeout or non-JSON answer
 */
export type MoontonOutcome = 'ok' | 'token_expired' | 'offline' | 'error' | 'unreachable';

export interface MoontonResult<T = any> {
  ok: boolean;
  outcome: MoontonOutcome;
  code: number | null;
  message: string | null;
  httpStatus: number | null;
  data: T | null;
}

/**
 * Session refusals. `1002 auth is empty` (actgateway), `-20020 token不合法`
 * (sg-api without a valid token) and HTTP 401 `{code:401}` (sg-api with a
 * forged/expired token).
 */
export const TOKEN_ERROR_CODES = new Set([1002, -20020, 401]);
/** Route taken offline by Moonton ("接口下线", interface decommissioned). */
export const OFFLINE_CODES = new Set([10407]);

/** Classify a Moonton answer. Pure: tested without network. */
export function classifyMoonton(httpStatus: number | null, body: any): MoontonResult {
  const base = { httpStatus, data: null as any };
  if (body === null || body === undefined || typeof body !== 'object') {
    if (httpStatus === 401 || httpStatus === 403) {
      return { ...base, ok: false, outcome: 'token_expired', code: httpStatus, message: null };
    }
    return { ...base, ok: false, outcome: 'unreachable', code: null, message: null };
  }
  const rawCode = body.code;
  const code = typeof rawCode === 'number' ? rawCode : rawCode != null && rawCode !== '' ? Number(rawCode) : null;
  const message =
    (typeof body.message === 'string' && body.message) ||
    (typeof body.msg === 'string' && body.msg) ||
    null;
  if (code === 0) {
    return { httpStatus, ok: true, outcome: 'ok', code, message, data: body.data ?? null };
  }
  let outcome: MoontonOutcome = 'error';
  if (code !== null && OFFLINE_CODES.has(code)) outcome = 'offline';
  else if ((code !== null && TOKEN_ERROR_CODES.has(code)) || httpStatus === 401) outcome = 'token_expired';
  return { ...base, ok: false, outcome, code: Number.isNaN(code as number) ? null : code, message };
}

function stripBearer(jwt: string): string {
  return jwt.replace(/^Bearer\s+/i, '').trim();
}

function baseHeaders(): Record<string, string> {
  return {
    'User-Agent': MLBB_UA,
    Accept: 'application/json, text/plain, */*',
    Origin: MLBB_ORIGIN,
    Referer: `${MLBB_ORIGIN}/`,
  };
}

/**
 * actgateway headers. The gateway authenticates with `x-token` ONLY (see
 * api-research/ARENA_UPSTREAM.md): never send `authorization` there.
 */
export function actHeaders(jwt: string, lang = 'en'): Record<string, string> {
  return { ...baseHeaders(), 'x-token': stripBearer(jwt), 'x-lang': lang };
}

/** sg-api headers: form body; with a session, `authorization` + `x-token`. */
export function sgHeaders(
  opts: { jwt?: string | null; forInfo?: boolean; lang?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    ...baseHeaders(),
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };
  if (opts.jwt) {
    const t = stripBearer(opts.jwt);
    headers['authorization'] = t;
    headers['x-token'] = t;
  }
  if (opts.forInfo) {
    headers['x-actid'] = MLBB_X_ACTID;
    headers['x-appid'] = MLBB_X_APPID;
    headers['x-lang'] = opts.lang ?? 'en';
  }
  return headers;
}

export function encodeQuery(data: Record<string, any>): string {
  const entries = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)] as [string, string]);
  return new URLSearchParams(entries).toString();
}

/**
 * Expiry date carried by a Moonton JWT (`exp` claim, unverified), or null when
 * the token is not a JWT or has no `exp`.
 */
export function jwtExpiry(token: string | null | undefined): Date | null {
  if (!token) return null;
  const parts = stripBearer(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

export type FetchFn = (url: string, init?: any) => Promise<{ status: number; json: () => Promise<any> }>;
export const MOONTON_FETCH = 'MOONTON_FETCH';

/** Thin, logged, never-throwing client for the Moonton player endpoints. */
@Injectable()
export class MoontonClient {
  private readonly logger = new Logger('MoontonClient');
  private readonly fetchFn: FetchFn;

  constructor(@Optional() @Inject(MOONTON_FETCH) fetchFn?: FetchFn) {
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init) as any);
  }

  /** GET on actgateway (battlereport/*), authenticated by `x-token`. */
  async actGet<T = any>(
    path: string,
    params: Record<string, any>,
    jwt: string,
    lang = 'en',
  ): Promise<MoontonResult<T>> {
    const qs = encodeQuery(params);
    const url = `${ACT_BASE}/${path}${qs ? `?${qs}` : ''}`;
    return this.call(`act ${path}`, url, { method: 'GET', headers: actHeaders(jwt, lang) });
  }

  /** Form POST on sg-api (sendVc/login/logout/getBaseInfo). */
  async sgPost<T = any>(
    path: string,
    form: Record<string, any>,
    opts: { jwt?: string | null; forInfo?: boolean; lang?: string } = {},
  ): Promise<MoontonResult<T>> {
    return this.call(`sg ${path}`, `${SG_BASE}${path}`, {
      method: 'POST',
      headers: sgHeaders(opts),
      body: encodeQuery(form),
    });
  }

  private async call(label: string, url: string, init: any): Promise<MoontonResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let status: number | null = null;
    let body: any = null;
    try {
      const res = await this.fetchFn(url, { ...init, signal: controller.signal });
      status = res.status;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } catch (e: any) {
      // Never log the request (headers carry the session token).
      this.logger.warn(`Moonton ${label} unreachable: ${e?.name === 'AbortError' ? 'timeout' : e?.message ?? e}`);
      return { ok: false, outcome: 'unreachable', code: null, message: null, httpStatus: null, data: null };
    } finally {
      clearTimeout(timer);
    }
    const result = classifyMoonton(status, body);
    if (!result.ok) {
      this.logger.warn(
        `Moonton ${label} failed: outcome=${result.outcome} http=${status} code=${result.code} message=${result.message ?? '-'}`,
      );
    }
    return result;
  }
}
