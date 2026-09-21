import * as crypto from 'crypto';

// Encryption at rest for OAuth tokens / stream keys / integration secrets.
// The key comes from ENCRYPTION_KEY (32+ chars); we use its first 32 bytes. It
// is read at call time (not at import time) so that a key loaded by dotenv
// after this module was imported is still honoured.
//
// Formats:
// - current: `v2:<iv>:<tag>:<ciphertext>` (hex), AES-256-GCM. The auth tag
//   makes a wrong key or a tampered value fail loudly instead of returning
//   garbage.
// - legacy:  `<iv>:<ciphertext>` (hex), AES-256-CBC. Still decrypted so the
//   values stored before the switch keep working; they are rewritten in the
//   current format the next time they are saved.
const LEGACY_ALGORITHM = 'aes-256-cbc';
const ALGORITHM = 'aes-256-gcm';
const VERSION_PREFIX = 'v2:';
const GCM_IV_BYTES = 12;

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super('ENCRYPTION_KEY is missing or shorter than 32 characters.');
    this.name = 'EncryptionKeyMissingError';
  }
}

/** True when a usable ENCRYPTION_KEY (at least 32 characters) is configured. */
export function isEncryptionConfigured(): boolean {
  return (process.env.ENCRYPTION_KEY ?? '').length >= 32;
}

/**
 * Key buffer. Throws when ENCRYPTION_KEY is unusable: a process-local random
 * key would produce values nobody can decrypt after a restart.
 */
function encryptionKey(): Buffer {
  if (!isEncryptionConfigured()) throw new EncryptionKeyMissingError();
  return Buffer.from((process.env.ENCRYPTION_KEY as string).slice(0, 32));
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Decrypts both formats. Throws on a missing/wrong key or a corrupted value. */
export function decrypt(text: string): string {
  if (!text) return '';
  const key = encryptionKey();
  if (text.startsWith(VERSION_PREFIX)) {
    const [ivHex, tagHex, dataHex] = text.slice(VERSION_PREFIX.length).split(':');
    if (!ivHex || !tagHex || dataHex === undefined) throw new Error('Malformed encrypted value.');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  }
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift() as string, 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString();
}
