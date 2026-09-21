import * as crypto from 'crypto';
import { EncryptionKeyMissingError, decrypt, encrypt, isEncryptionConfigured } from './crypto.util';

const KEY = '0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'fedcba9876543210fedcba9876543210';

/** Exact replica of the pre-#131 AES-256-CBC `encrypt` (legacy stored values). */
function legacyEncrypt(text: string, key: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32)), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

describe('crypto.util', () => {
  const saved = process.env.ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = saved;
  });

  it('round-trips new values in the versioned GCM format', () => {
    const value = encrypt('{"apiSecret":"s3cr3t:with:colons"}');
    expect(value.startsWith('v2:')).toBe(true);
    expect(value).not.toContain('s3cr3t');
    expect(decrypt(value)).toBe('{"apiSecret":"s3cr3t:with:colons"}');
  });

  it('still decrypts legacy AES-CBC values', () => {
    const legacy = legacyEncrypt('ya29.legacy-token', KEY);
    expect(legacy.startsWith('v2:')).toBe(false);
    expect(decrypt(legacy)).toBe('ya29.legacy-token');
  });

  it('returns an empty string for an empty value', () => {
    expect(decrypt('')).toBe('');
  });

  it('fails loudly with a wrong key or a tampered value (no garbage)', () => {
    const value = encrypt('hello');
    process.env.ENCRYPTION_KEY = OTHER_KEY;
    expect(() => decrypt(value)).toThrow();
    process.env.ENCRYPTION_KEY = KEY;
    const parts = value.split(':');
    const data = parts[3];
    parts[3] = (data[0] === '0' ? '1' : '0') + data.slice(1);
    expect(() => decrypt(parts.join(':'))).toThrow();
  });

  it('throws instead of using a random key when ENCRYPTION_KEY is unset or too short', () => {
    const value = encrypt('hello');
    delete process.env.ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => decrypt(value)).toThrow(EncryptionKeyMissingError);
    expect(() => encrypt('hello')).toThrow(EncryptionKeyMissingError);
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => decrypt(value)).toThrow(EncryptionKeyMissingError);
  });
});
