// Thin Cloudinary HTTP client used by the media service. Only two calls are
// needed server side: read an uploaded resource (Admin API, basic auth) and
// destroy one (Upload API, signed). Both go through an injectable `fetch` so
// tests never hit the network.

import { CloudinaryConfig } from '../integrations/integrations.logic';
import { CloudinaryResource, cloudinarySignature } from './media.logic';

export const DEFAULT_CLOUDINARY_API_BASE = 'https://api.cloudinary.com';
const TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class CloudinaryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'CloudinaryError';
  }
}

export interface CloudinaryClient {
  /** Admin API resource, or null when it does not exist (404). */
  getResource(config: CloudinaryConfig, publicId: string): Promise<CloudinaryResource | null>;
  /** Destroys an uploaded image (true when deleted or already gone). */
  destroy(config: CloudinaryConfig, publicId: string): Promise<boolean>;
}

const encodePublicId = (publicId: string) => publicId.split('/').map(encodeURIComponent).join('/');

export function createCloudinaryClient(
  apiBase: string = DEFAULT_CLOUDINARY_API_BASE,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): CloudinaryClient {
  const base = apiBase.replace(/\/+$/, '');
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new CloudinaryError(`Cloudinary injoignable : ${(err as Error).message}`, null);
    }
  };

  return {
    async getResource(config, publicId) {
      const url =
        `${base}/v1_1/${encodeURIComponent(config.cloudName)}/resources/image/upload/` +
        `${encodePublicId(publicId)}?pages=true`;
      const auth = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
      const res = await call(url, { headers: { Authorization: `Basic ${auth}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new CloudinaryError(`Lecture Cloudinary impossible (HTTP ${res.status}).`, res.status);
      return (await res.json()) as CloudinaryResource;
    },

    async destroy(config, publicId) {
      const params = { invalidate: 'true', public_id: publicId, timestamp: nowSeconds() };
      const body = new URLSearchParams({
        ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        api_key: config.apiKey,
        signature: cloudinarySignature(params, config.apiSecret),
      });
      const res = await call(`${base}/v1_1/${encodeURIComponent(config.cloudName)}/image/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) throw new CloudinaryError(`Suppression Cloudinary impossible (HTTP ${res.status}).`, res.status);
      const data = (await res.json().catch(() => ({}))) as { result?: string };
      return data.result === 'ok' || data.result === 'not found';
    },
  };
}
