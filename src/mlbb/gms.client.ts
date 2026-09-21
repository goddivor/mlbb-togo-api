import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { ACT_ID, APP_HEROES, GMS_BASE, GMS_USER_AGENT, GmsAppId } from './gms.constants';

export interface GmsData {
  records: any[];
  total: number;
}

/** Raised when Moonton is unreachable, times out or answers `code !== 0`. */
export class GmsError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
    this.name = 'GmsError';
  }
}

type FetchFn = typeof fetch;

/**
 * Thin client for the Moonton GMS API (`POST /api/gms/source/<app>/<source>`).
 *
 * Moonton does not enforce the HMAC `authorization` header today, but the
 * official site sends it, so we keep signing (disable with MLBB_GMS_SIGN=0).
 * A failure to get the signing key never blocks a call: it is sent unsigned.
 */
@Injectable()
export class GmsClient {
  private readonly logger = new Logger('GmsClient');
  private enigmaCache: { value: string; expiresAt: number } | null = null;
  private readonly timeoutMs = Number(process.env.MLBB_GMS_TIMEOUT_MS) || 10_000;
  private readonly signEnabled = process.env.MLBB_GMS_SIGN !== '0';
  // Overridable in tests.
  fetchFn: FetchFn = (input, init) => fetch(input, init);

  headers(lang = 'en'): Record<string, string> {
    return {
      'x-appid': APP_HEROES,
      'x-actid': ACT_ID,
      'x-lang': lang,
      origin: 'https://www.mobilelegends.com',
      referer: 'https://www.mobilelegends.com/',
      'user-agent': GMS_USER_AGENT,
      accept: 'application/json, text/plain, */*',
    };
  }

  /** HMAC-SHA1 signature used by www.mobilelegends.com. */
  static sign(method: string, pathname: string, query: string, body: string, enigma: string): string {
    const message = [method.toUpperCase(), pathname, query || '', body || '{}'].join('\n');
    return crypto.createHmac('sha1', enigma).update(message, 'utf8').digest('base64');
  }

  private async getEnigma(): Promise<string | null> {
    const now = Date.now();
    if (this.enigmaCache && this.enigmaCache.expiresAt > now) return this.enigmaCache.value;
    try {
      const res = await this.fetchFn(`${GMS_BASE}/api/act/basev4?_t=${now}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const json: any = await res.json();
      const enigma = json?.data?.server?.enigma;
      if (enigma) {
        this.enigmaCache = { value: enigma, expiresAt: now + 10 * 60 * 1000 };
        return enigma;
      }
    } catch (e) {
      this.logger.debug(`enigma unavailable: ${(e as Error).message}`);
    }
    return this.enigmaCache?.value ?? null;
  }

  /**
   * Calls one GMS source and returns `data` ({ records, total }).
   * Throws a GmsError on HTTP error, timeout or `code !== 0`.
   * `timeoutMs` overrides the default for heavy payloads (full hero list).
   */
  async callSource(
    appId: GmsAppId,
    sourceId: string,
    body: Record<string, any>,
    lang = 'en',
    opts: { timeoutMs?: number } = {},
  ): Promise<GmsData> {
    const pathname = `/api/gms/source/${appId}/${sourceId}`;
    const bodyStr = JSON.stringify(body);
    const headers: Record<string, string> = {
      ...this.headers(lang),
      'content-type': 'application/json;charset=UTF-8',
    };
    if (this.signEnabled) {
      const enigma = await this.getEnigma();
      if (enigma) headers.authorization = GmsClient.sign('POST', pathname, '', bodyStr, enigma);
    }

    let json: any;
    try {
      const res = await this.fetchFn(`${GMS_BASE}${pathname}`, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
      if (!res.ok) throw new GmsError(`GMS ${appId}/${sourceId}: HTTP ${res.status}`, res.status);
      json = await res.json();
    } catch (e) {
      if (e instanceof GmsError) throw e;
      throw new GmsError(`GMS ${appId}/${sourceId}: ${(e as Error).message}`);
    }
    if (json?.code !== 0) {
      this.logger.warn(`GMS ${appId}/${sourceId} code=${json?.code} message=${json?.message}`);
      throw new GmsError(`GMS ${appId}/${sourceId}: ${json?.message ?? 'unknown error'}`, json?.code);
    }
    return {
      records: Array.isArray(json?.data?.records) ? json.data.records : [],
      total: Number(json?.data?.total ?? json?.data?.records?.length ?? 0),
    };
  }
}
