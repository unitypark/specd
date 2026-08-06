import { describe, expect, it } from 'vitest';
import { Vault, redactSecrets } from './vault.js';
import { Config } from '../config.js';

function makeVault(keyB64 = Buffer.alloc(32, 7).toString('base64')): Vault {
  // Config reads the environment at construction; set only what the vault needs.
  process.env.DATABASE_URL ??= 'postgres://x/x';
  process.env.JWT_SECRET ??= 'test';
  process.env.VAULT_MASTER_KEY = keyB64;
  return new Vault(new Config());
}

describe('credential vault', () => {
  it('round-trips a secret', () => {
    const vault = makeVault();
    const secret = 'sk-ant-api03-abcdefghijklmnop';
    const blob = vault.encrypt(secret, 'project-1:ai');
    expect(blob).not.toContain(secret);
    expect(vault.decrypt(blob, 'project-1:ai')).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    const vault = makeVault();
    const a = vault.encrypt('same', 'ctx');
    const b = vault.encrypt('same', 'ctx');
    expect(a).not.toBe(b);
    expect(vault.decrypt(a, 'ctx')).toBe(vault.decrypt(b, 'ctx'));
  });

  it('refuses to decrypt under a different owner', () => {
    // The AAD binds ciphertext to its project and kind, so a row copied
    // between projects is useless rather than portable.
    const vault = makeVault();
    const blob = vault.encrypt('secret', 'project-1:ai');
    expect(() => vault.decrypt(blob, 'project-2:ai')).toThrow();
    expect(() => vault.decrypt(blob, 'project-1:vcs')).toThrow();
  });

  it('refuses tampered ciphertext', () => {
    const vault = makeVault();
    const blob = vault.encrypt('secret', 'ctx');
    const parts = blob.split('.');
    const flipped = Buffer.from(parts[4]!, 'base64');
    flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
    parts[4] = flipped.toString('base64');
    expect(() => vault.decrypt(parts.join('.'), 'ctx')).toThrow();
  });

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => makeVault(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
  });

  it('masks secrets for display without revealing the middle', () => {
    const masked = Vault.mask('sk-ant-api03-supersecretvalue6f2q');
    expect(masked.startsWith('sk-ant-a')).toBe(true);
    expect(masked.endsWith('6f2q')).toBe(true);
    expect(masked).not.toContain('supersecret');
  });
});

describe('log redaction', () => {
  it('strips credentials that would otherwise be archived', () => {
    const cases = [
      'using key sk-ant-api03-abcdefghijklmnopqrst now',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'glpat-abcdefghij1234567890',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    ];
    for (const line of cases) {
      expect(redactSecrets(line)).toContain('[redacted]');
    }
  });

  it('leaves ordinary log lines alone', () => {
    const line = 'indexed knowledge/architecture.md (3 UNVERIFIED claims)';
    expect(redactSecrets(line)).toBe(line);
  });
});
