import {
  applyPatch,
  describeChanges,
  isEmptyDoc,
  maskSecret,
  parseCloudinaryUrl,
  resolveAnthropic,
  resolveCloudinary,
} from './integrations.logic';
import { DEFAULT_AI_MODEL } from '../ai/ai-llm';

describe('maskSecret', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskSecret('sk-ant-api03-abcdefWXYZ')).toBe('••••WXYZ');
    expect(maskSecret('  12345678  ')).toBe('••••5678');
  });

  it('fully hides short values and returns null when empty', () => {
    expect(maskSecret('abc123')).toBe('••••');
    expect(maskSecret('')).toBeNull();
    expect(maskSecret('   ')).toBeNull();
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
  });
});

describe('applyPatch', () => {
  const stored = { apiKey: 'sk-old-key-1234', model: 'claude-sonnet-4-6' };

  it('keeps missing fields and empty secrets', () => {
    expect(applyPatch('anthropic', stored, {})).toEqual({ next: stored, changed: [] });
    expect(applyPatch('anthropic', stored, { apiKey: '' })).toEqual({ next: stored, changed: [] });
    expect(applyPatch('anthropic', stored, { apiKey: '   ', model: undefined })).toEqual({
      next: stored,
      changed: [],
    });
  });

  it('replaces a secret with a trimmed value and removes it on null', () => {
    expect(applyPatch('anthropic', stored, { apiKey: ' sk-new-5678 ' })).toEqual({
      next: { ...stored, apiKey: 'sk-new-5678' },
      changed: ['apiKey'],
    });
    expect(applyPatch('anthropic', stored, { apiKey: null })).toEqual({
      next: { model: 'claude-sonnet-4-6' },
      changed: ['apiKey'],
    });
  });

  it('clears plain fields on empty string or null', () => {
    expect(applyPatch('anthropic', stored, { model: '' }).next).toEqual({ apiKey: 'sk-old-key-1234' });
    expect(applyPatch('anthropic', stored, { model: null }).changed).toEqual(['model']);
  });

  it('ignores unknown fields, non-string values and unchanged values', () => {
    const res = applyPatch('cloudinary', { cloudName: 'demo' }, {
      cloudName: 'demo',
      evil: 'x',
      apiKey: 42,
      folder: 'mlbb',
    });
    expect(res).toEqual({ next: { cloudName: 'demo', folder: 'mlbb' }, changed: ['folder'] });
  });

  it('describes changes without leaking secret values', () => {
    const { next, changed } = applyPatch('cloudinary', { apiSecret: 'old' }, {
      apiSecret: 'super-secret-value',
      apiKey: '123456789',
      cloudName: 'demo',
      folder: null,
    });
    const text = describeChanges('cloudinary', next, changed);
    expect(text).toBe('cloudName=demo, apiKey updated, apiSecret updated');
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('123456789');
    expect(describeChanges('anthropic', {}, ['apiKey', 'model'])).toBe('apiKey removed, model cleared');
  });

  it('detects empty documents', () => {
    expect(isEmptyDoc({})).toBe(true);
    expect(isEmptyDoc({ model: '  ' })).toBe(true);
    expect(isEmptyDoc({ model: 'x' })).toBe(false);
  });
});

describe('resolveAnthropic', () => {
  it('prefers the stored key and model', () => {
    const r = resolveAnthropic(
      { apiKey: 'db-key', model: 'claude-haiku-4-5' },
      { ANTHROPIC_API_KEY: 'env-key', AI_MODEL: 'env-model' },
    );
    expect(r).toEqual({ config: { apiKey: 'db-key', model: 'claude-haiku-4-5' }, model: 'claude-haiku-4-5', source: 'db' });
  });

  it('falls back to env, then to the default model', () => {
    expect(resolveAnthropic({}, { ANTHROPIC_API_KEY: ' env-key ', AI_MODEL: 'env-model' })).toEqual({
      config: { apiKey: 'env-key', model: 'env-model' },
      model: 'env-model',
      source: 'env',
    });
    expect(resolveAnthropic({ model: 'claude-x' }, { ANTHROPIC_API_KEY: 'env-key' }).config).toEqual({
      apiKey: 'env-key',
      model: 'claude-x',
    });
    expect(resolveAnthropic({}, {})).toEqual({ config: null, model: DEFAULT_AI_MODEL, source: null });
  });
});

describe('resolveCloudinary', () => {
  it('parses CLOUDINARY_URL', () => {
    expect(parseCloudinaryUrl('cloudinary://123:abc%2Fdef@my-cloud')).toEqual({
      apiKey: '123',
      apiSecret: 'abc/def',
      cloudName: 'my-cloud',
    });
    expect(parseCloudinaryUrl('https://nope')).toEqual({});
    expect(parseCloudinaryUrl(undefined)).toEqual({});
  });

  it('merges stored values over env, field by field', () => {
    const r = resolveCloudinary(
      { cloudName: 'db-cloud', apiSecret: 'db-secret' },
      { CLOUDINARY_CLOUD_NAME: 'env-cloud', CLOUDINARY_API_KEY: 'env-key', CLOUDINARY_FOLDER: 'env-folder' },
    );
    expect(r.config).toEqual({ cloudName: 'db-cloud', apiKey: 'env-key', apiSecret: 'db-secret', folder: 'env-folder' });
    expect(r.source).toBe('db');
  });

  it('uses CLOUDINARY_URL as the last env fallback and needs all three credentials', () => {
    const r = resolveCloudinary({}, { CLOUDINARY_URL: 'cloudinary://k:s@c', CLOUDINARY_API_KEY: 'k2' });
    expect(r.config).toEqual({ cloudName: 'c', apiKey: 'k2', apiSecret: 's', folder: null });
    expect(r.source).toBe('env');
    const partial = resolveCloudinary({ cloudName: 'only' }, {});
    expect(partial.config).toBeNull();
    expect(partial.source).toBeNull();
    expect(partial.partial.cloudName).toBe('only');
  });
});
