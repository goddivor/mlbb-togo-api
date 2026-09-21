import * as crypto from 'crypto';

// AES-256-CBC encryption for OAuth tokens / stream keys / integration secrets
// at rest. The key comes from ENCRYPTION_KEY (32+ chars); we use its first 32
// bytes. It is read at call time (not at import time) so that a key loaded by
// dotenv after this module was imported is still honoured.
const ALGORITHM = 'aes-256-cbc';

// Process-local fallback used when ENCRYPTION_KEY is missing. Data encrypted
// with it cannot be decrypted by another instance or after a restart: callers
// storing durable secrets must check `isEncryptionConfigured()` first.
let fallbackKey: string | null = null;

function encryptionKey(): string {
  const configured = process.env.ENCRYPTION_KEY;
  if (configured) return configured;
  if (!fallbackKey) fallbackKey = crypto.randomBytes(32).toString('hex');
  return fallbackKey;
}

/** True when a usable ENCRYPTION_KEY (at least 32 characters) is configured. */
export function isEncryptionConfigured(): boolean {
  return (process.env.ENCRYPTION_KEY ?? '').length >= 32;
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(encryptionKey().slice(0, 32)),
    iv,
  );
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(text: string): string {
  if (!text) return '';
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift() as string, 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(encryptionKey().slice(0, 32)),
    iv,
  );
  const decrypted = Buffer.concat([
    decipher.update(encryptedText),
    decipher.final(),
  ]);
  return decrypted.toString();
}
