// Cheap connectivity checks run by the admin "Test" buttons. They never throw:
// every failure is turned into a `{ ok: false, code }` result the UI can
// translate.

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicConfig, CloudinaryConfig } from './integrations.logic';

export type TestCode =
  | 'ok'
  | 'not_configured'
  | 'unauthorized'
  | 'model_not_found'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'error';

export interface TestResult {
  ok: boolean;
  code: TestCode;
  message: string;
  /** Extra non-secret info (model display name, Cloudinary status...). */
  detail?: string;
}

const TEST_TIMEOUT_MS = 15_000;

export const notConfigured = (): TestResult => ({
  ok: false,
  code: 'not_configured',
  message: 'Intégration non configurée.',
});

function codeFromStatus(status: number | undefined): TestCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'error';
}

/** Minimal model lookup surface (lets tests inject a fake). */
export type AnthropicModelsLike = {
  models: { retrieve(model: string): Promise<{ id: string; display_name?: string }> };
};

/**
 * Retrieves the configured model: free, checks both the key and that the
 * model exists for this key.
 */
export async function testAnthropic(
  config: AnthropicConfig,
  makeClient: (apiKey: string) => AnthropicModelsLike = (apiKey) =>
    new Anthropic({ apiKey, maxRetries: 0, timeout: TEST_TIMEOUT_MS }),
): Promise<TestResult> {
  try {
    const info = await makeClient(config.apiKey).models.retrieve(config.model);
    return {
      ok: true,
      code: 'ok',
      message: 'Connexion à Anthropic réussie.',
      detail: info.display_name || info.id,
    };
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionError) {
      return { ok: false, code: 'network', message: 'Anthropic injoignable.' };
    }
    const status = (err as { status?: number }).status;
    const code = codeFromStatus(status);
    if (code === 'not_found') {
      return { ok: false, code: 'model_not_found', message: `Modèle introuvable : ${config.model}.` };
    }
    if (code === 'unauthorized') {
      return { ok: false, code, message: 'Clé API Anthropic refusée.' };
    }
    return {
      ok: false,
      code,
      message: `Échec du test Anthropic${status ? ` (HTTP ${status})` : ''}.`,
    };
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Calls the Cloudinary Admin API `ping` endpoint with HTTP basic auth. */
export async function testCloudinary(
  config: CloudinaryConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<TestResult> {
  const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/ping`;
  const auth = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'network', message: 'Cloudinary injoignable.' };
  }
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      code: 'ok',
      message: 'Connexion à Cloudinary réussie.',
      detail: typeof body?.status === 'string' ? body.status : undefined,
    };
  }
  const code = codeFromStatus(res.status);
  if (code === 'unauthorized') {
    return { ok: false, code, message: 'Identifiants Cloudinary refusés.' };
  }
  if (code === 'not_found') {
    return { ok: false, code, message: `Cloud introuvable : ${config.cloudName}.` };
  }
  return { ok: false, code, message: `Échec du test Cloudinary (HTTP ${res.status}).` };
}
