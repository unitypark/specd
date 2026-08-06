import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportJWK, jwtVerify } from 'jose';
import { GitHubAppService, isPubliclyReachable } from './github-app.service.js';
import type { Config } from '../config.js';

/**
 * Real keys, real signatures. A mocked signer would prove nothing about the
 * only property that matters here: that GitHub can verify what we send.
 */

let pkcs1: string;
let pkcs8: string;
let publicKeyPem: string;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); PKCS#8 shows up when
  // someone has run the key through openssl. Both have to work.
  pkcs1 = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const jwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256' }] });
});

function service(overrides: Partial<Config> = {}): GitHubAppService {
  return new GitHubAppService({
    githubAppId: '123456',
    githubPrivateKey: pkcs1,
    githubWebhookSecret: 'secret',
    githubApiBase: 'https://api.github.com',
    ...overrides,
  } as Config);
}

describe('appJwt', () => {
  it('produces an RS256 JWT GitHub can verify with the public key', async () => {
    const token = await service().appJwt();
    expect(decodeProtectedHeader(token).alg).toBe('RS256');

    const { payload } = await jwtVerify(token, jwks, { issuer: '123456' });
    expect(payload.iss).toBe('123456');
  });

  it('backdates iat so a second of clock skew does not get it rejected', async () => {
    // GitHub rejects a JWT whose iat is in the future. Servers disagree about
    // "now" by more than zero, and the failure is a flat 401 with no hint.
    const now = Math.floor(Date.now() / 1000);
    const claims = decodeJwt(await service().appJwt());
    expect(claims.iat).toBeLessThan(now);
    expect(now - claims.iat!).toBeGreaterThanOrEqual(30);
  });

  it('expires inside GitHub’s ten-minute ceiling', async () => {
    // GitHub refuses anything longer-lived than ten minutes.
    const claims = decodeJwt(await service().appJwt());
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(660);
    expect(claims.exp!).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('accepts a PKCS#8 key too', async () => {
    const token = await service({ githubPrivateKey: pkcs8 }).appJwt();
    await expect(jwtVerify(token, jwks, { issuer: '123456' })).resolves.toBeTruthy();
  });

  it('accepts a key pasted with escaped newlines', async () => {
    // How the key survives most .env files and secret managers: one line with
    // literal \n. Failing on that shape sends people on a long detour.
    const escaped = pkcs1.replace(/\n/g, '\\n');
    const token = await service({ githubPrivateKey: escaped }).appJwt();
    await expect(jwtVerify(token, jwks, { issuer: '123456' })).resolves.toBeTruthy();
  });

  it('explains itself when the key is not a key', async () => {
    const svc = service({ githubPrivateKey: 'this is not a pem' });
    await expect(svc.appJwt()).rejects.toThrow(/could not be read as a private key/i);
  });

  it('refuses a public key where a private one belongs', async () => {
    const svc = service({ githubPrivateKey: publicKeyPem });
    await expect(svc.appJwt()).rejects.toThrow(/private key/i);
  });
});

describe('configuration reporting', () => {
  it('knows when it is unconfigured and names the missing variables', () => {
    const svc = new GitHubAppService({
      githubAppId: '',
      githubPrivateKey: '',
      githubWebhookSecret: '',
    } as Config);

    expect(svc.isConfigured).toBe(false);
    expect(svc.unconfiguredReason).toContain('GITHUB_APP_ID');
    expect(svc.unconfiguredReason).toContain('GITHUB_APP_PRIVATE_KEY');
    expect(svc.unconfiguredReason).toContain('GITHUB_WEBHOOK_SECRET');
  });

  it('still flags a missing webhook secret when the App itself is usable', () => {
    // The App can mint tokens and open PRs with no webhook secret — and every
    // delivery it sends will be rejected. Silence here means merges never
    // re-index and nobody knows why.
    const svc = service({ githubWebhookSecret: '' });
    expect(svc.isConfigured).toBe(true);
    expect(svc.unconfiguredReason).toContain('GITHUB_WEBHOOK_SECRET');
  });

  it('reports nothing missing when fully configured', () => {
    expect(service().unconfiguredReason).toBe('');
  });
});

describe('manifest', () => {
  const manifest = () =>
    service().manifest('https://specd.example.com', 'https://specd.example.com/api/github/webhook');

  it('requests only the permissions the pipeline uses', () => {
    // The answer to "you want write access to our repos?" is: contents and
    // pull requests, nothing else — and the write path is PRs only (§15).
    expect(manifest().default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
  });

  it('asks for no permission beyond those three', () => {
    const permissions = manifest().default_permissions as Record<string, string>;
    expect(Object.keys(permissions).sort()).toEqual(['contents', 'metadata', 'pull_requests']);
    for (const scope of ['administration', 'workflows', 'packages', 'members', 'secrets']) {
      expect(permissions[scope]).toBeUndefined();
    }
  });

  it('subscribes only to events an App is allowed to subscribe to', () => {
    // GitHub rejects the whole manifest if it lists `installation` or
    // `installation_repositories`: every App receives those automatically, so
    // asking for them is an error rather than a redundancy.
    expect(manifest().default_events).toEqual(['push', 'pull_request']);
  });

  it('points the webhook at the receiving endpoint and enables it', () => {
    expect(manifest().hook_attributes).toEqual({
      url: 'https://specd.example.com/api/github/webhook',
      active: true,
    });
  });

  it('omits the webhook entirely when GitHub could not reach it', () => {
    // GitHub refuses a manifest whose hook url is not publicly reachable, so a
    // localhost deployment must register without one — otherwise the App
    // cannot be registered from a laptop, which is where it gets set up.
    const local = service().manifest(
      'http://localhost:4000',
      'http://localhost:4000/api/github/webhook',
    );
    expect(local.hook_attributes).toBeUndefined();
    expect(local.default_permissions).toBeDefined();
  });

  it('is private by default', () => {
    // A public App can be installed by strangers. Nothing about specd wants that.
    expect(manifest().public).toBe(false);
  });
});

describe('isPubliclyReachable', () => {
  it('rejects everything GitHub cannot deliver to', () => {
    for (const url of [
      'http://localhost:4000/api/github/webhook',
      'http://127.0.0.1:4000/hook',
      'http://0.0.0.0:4000/hook',
      'http://[::1]:4000/hook',
      'http://192.168.1.50/hook',
      'http://10.0.0.4/hook',
      'http://172.16.0.9/hook',
      'http://172.31.255.1/hook',
      'http://169.254.10.1/hook',
      'http://specd.local/hook',
      'http://my-laptop.internal/hook',
      'http://devbox/hook',
      'not a url',
    ]) {
      expect(isPubliclyReachable(url), `${url} must be treated as unreachable`).toBe(false);
    }
  });

  it('accepts real public hosts', () => {
    for (const url of [
      'https://specd.example.com/api/github/webhook',
      'https://long-name-1234.trycloudflare.com/api/github/webhook',
      'https://a1b2c3.ngrok-free.app/hook',
      'http://203.0.113.7/hook',
      'http://172.32.0.1/hook',
    ]) {
      expect(isPubliclyReachable(url), `${url} must be treated as reachable`).toBe(true);
    }
  });
});
