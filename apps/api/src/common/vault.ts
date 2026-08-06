import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Config } from '../config.js';

/**
 * Credential vault (§12). Envelope encryption with a per-tenant data key that
 * is itself encrypted under the master key, so rotating the master key never
 * requires touching ciphertext at rest, and a leaked data key is scoped to one
 * project.
 *
 * In production the master key comes from KMS; here it comes from the
 * environment. The shape is the same either way, which is the point — the
 * decrypt path is the only place plaintext exists, and it is never logged.
 *
 * Format: v1.<b64 wrapped-dek>.<b64 iv>.<b64 tag>.<b64 ciphertext>
 */
@Injectable()
export class Vault {
  private readonly masterKey: Buffer;

  constructor(config: Config) {
    const raw = Buffer.from(config.vaultMasterKey, 'base64');
    if (raw.length !== 32) {
      throw new Error(
        'VAULT_MASTER_KEY must be 32 bytes, base64-encoded. Generate: openssl rand -base64 32',
      );
    }
    this.masterKey = raw;
  }

  encrypt(plaintext: string, aad: string): string {
    const dek = randomBytes(32);

    // Wrap the data key under the master key.
    const dekIv = randomBytes(12);
    const dekCipher = createCipheriv('aes-256-gcm', this.masterKey, dekIv);
    const wrapped = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
    const dekTag = dekCipher.getAuthTag();
    const wrappedDek = Buffer.concat([dekIv, dekTag, wrapped]);

    // Encrypt the secret under the data key, binding it to its owner.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    dek.fill(0);

    return [
      'v1',
      wrappedDek.toString('base64'),
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(blob: string, aad: string): string {
    const parts = blob.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') {
      throw new Error('vault: unrecognized ciphertext format');
    }
    const [, wrappedB64, ivB64, tagB64, ctB64] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];

    const wrappedDek = Buffer.from(wrappedB64, 'base64');
    const dekIv = wrappedDek.subarray(0, 12);
    const dekTag = wrappedDek.subarray(12, 28);
    const wrapped = wrappedDek.subarray(28);

    const dekDecipher = createDecipheriv('aes-256-gcm', this.masterKey, dekIv);
    dekDecipher.setAuthTag(dekTag);
    const dek = Buffer.concat([dekDecipher.update(wrapped), dekDecipher.final()]);

    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    dek.fill(0);
    return plaintext;
  }

  /** What the UI is allowed to show: enough to recognise, not enough to use. */
  static mask(secret: string): string {
    if (secret.length <= 8) return '••••';
    return `${secret.slice(0, 8)}${'•'.repeat(12)}${secret.slice(-4)}`;
  }
}

/**
 * Run-log scrubber. Logs are archived, so anything that looks like a
 * credential is redacted on the way in rather than trusted not to appear.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /glpat-[A-Za-z0-9_-]{8,}/g,
  /pa_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}
