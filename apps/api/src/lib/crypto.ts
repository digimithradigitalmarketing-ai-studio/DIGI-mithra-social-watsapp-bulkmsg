import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * AES-256-GCM envelope for third-party credentials (Meta tokens, Gemini keys...).
 * Stored in public.integration_credentials, which has no grant for `authenticated`.
 */
export function encryptSecret(plaintext: string, keyB64: string, keyVersion = 1) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY must decode to 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion,
    lastFour: plaintext.slice(-4),
  };
}

export function decryptSecret(box: { ciphertext: string; iv: string; authTag: string }, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
