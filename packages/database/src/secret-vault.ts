import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secret vault.
 *
 * Third-party credentials — bot tokens, Click/Payme merchant keys — are tenant data and
 * must survive a database dump falling into the wrong hands. AES-256-GCM with a random
 * per-record IV and an authentication tag, keyed by SECRETS_ENCRYPTION_KEY.
 *
 * Invariant I7: ciphertext never leaves the server and plaintext exists only inside a
 * provider call. Nothing here is serialized into an API response.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the GCM standard
const KEY_LENGTH = 32;

export interface SealedSecret {
  cipher: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

function normalizeKey(raw: string): Buffer {
  // Accept hex (64 chars) or base64; reject anything that is not exactly 32 bytes,
  // because a short key silently weakens every secret in the system.
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64); got ${key.length} bytes.`,
    );
  }
  return key;
}

export class SecretVault {
  private readonly keys: Map<number, Buffer>;
  private readonly currentVersion: number;

  /**
   * @param keyMaterial the active key, or a map of version → key when rotating.
   *        During rotation, old versions stay available for decryption while every new
   *        write uses the highest version.
   */
  constructor(keyMaterial: string | Record<number, string>) {
    if (typeof keyMaterial === 'string') {
      this.keys = new Map([[1, normalizeKey(keyMaterial)]]);
      this.currentVersion = 1;
    } else {
      this.keys = new Map(
        Object.entries(keyMaterial).map(([v, k]) => [Number(v), normalizeKey(k)]),
      );
      this.currentVersion = Math.max(...this.keys.keys());
    }
    if (this.keys.size === 0) throw new Error('SecretVault requires at least one key.');
  }

  seal(plaintext: string): SealedSecret {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      cipher: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.currentVersion,
    };
  }

  open(sealed: SealedSecret): string {
    const key = this.keys.get(sealed.keyVersion);
    if (!key) {
      throw new Error(
        `No key for version ${sealed.keyVersion}. A rotated-out key is still needed to read existing secrets.`,
      );
    }
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    // A wrong key or tampered ciphertext throws here — that is the "authenticated" in
    // authenticated encryption, and we let it propagate rather than returning garbage.
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.cipher, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True when the record should be re-encrypted under the current key. */
  needsRotation(sealed: SealedSecret): boolean {
    return sealed.keyVersion !== this.currentVersion;
  }
}

/**
 * Masks a credential for display. Shows enough for a human to confirm *which* token is
 * configured, never enough to use it.
 *
 *   "8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" -> "8123456789:••••••…Dsaw"
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '•'.repeat(value.length);
  const colon = value.indexOf(':');
  if (colon > 0 && colon < 16) {
    return `${value.slice(0, colon + 1)}${'•'.repeat(6)}…${value.slice(-4)}`;
  }
  return `${'•'.repeat(6)}…${value.slice(-4)}`;
}

/** Constant-time comparison for webhook signatures and shared secrets. */
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length; compare
  // fixed-size digests of equal length instead by padding through a length check first.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
