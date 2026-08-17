import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  describeNonJsonBody,
  describeTransportFailure,
  fetchOrExplain,
  normalizeServiceUrl,
  readJsonOrExplain,
} from './http-failures.js';

/**
 * The class of bug this module exists to close: a failure that is not an
 * `HttpException` reaching a user as "Internal server error" or as a parser
 * complaining about a doctype. Three of them shipped before it was written.
 */

const transport = (code: string) => {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = { code };
  return err;
};

describe('describeTransportFailure', () => {
  it('turns each cause into the thing to go and check', () => {
    expect(describeTransportFailure(transport('ENOTFOUND'), 'https://h')).toMatch(/VPN/);
    expect(describeTransportFailure(transport('ECONNREFUSED'), 'https://h')).toMatch(/port/);
    expect(describeTransportFailure(transport('ETIMEDOUT'), 'https://h')).toMatch(/firewall/);
    expect(describeTransportFailure(transport('DEPTH_ZERO_SELF_SIGNED_CERT'), 'https://h')).toMatch(
      /NODE_EXTRA_CA_CERTS/,
    );
  });

  it('still says something for a cause it does not know', () => {
    expect(describeTransportFailure(transport('WAT'), 'https://h')).toContain('WAT');
  });

  it('declines errors that are not transport failures, so callers can rethrow', () => {
    // A SyntaxError from parsing is somebody else's story; claiming it here
    // would attach a VPN explanation to a malformed body.
    expect(describeTransportFailure(new SyntaxError('nope'), 'https://h')).toBeNull();
    expect(describeTransportFailure(new Error('nope'), 'https://h')).toBeNull();
  });
});

describe('describeNonJsonBody', () => {
  it('reads a doctype as a portal, which is what it always is', () => {
    expect(describeNonJsonBody('https://h/api', '<!DOCTYPE html><html>login</html>')).toMatch(
      /SSO or access portal.*login page at 200/s,
    );
  });

  it('quotes a short non-HTML body rather than inventing a portal', () => {
    expect(describeNonJsonBody('https://h/api', 'upstream connect error')).toContain(
      '"upstream connect error"',
    );
  });
});

describe('readJsonOrExplain', () => {
  const res = (status: number, body: string) =>
    ({ status, text: async () => body }) as unknown as Response;

  it('passes JSON through', async () => {
    await expect(
      readJsonOrExplain(res(200, '{"a":1}'), { url: 'u', wrap: (m) => new Error(m) }),
    ).resolves.toEqual({ a: 1 });
  });

  it('treats 204 and an empty body as absent, not as broken', async () => {
    // The trap every call site fell into: parsing '' fails exactly the way a
    // login page does, so a successful branch deletion reported a portal.
    await expect(
      readJsonOrExplain(res(204, ''), { url: 'u', wrap: (m) => new Error(m) }),
    ).resolves.toBeUndefined();
    await expect(
      readJsonOrExplain(res(200, ''), { url: 'u', wrap: (m) => new Error(m) }),
    ).resolves.toBeUndefined();
  });

  it('wraps a non-JSON body in whichever error type the caller uses', async () => {
    class Mine extends Error {}
    await expect(
      readJsonOrExplain(res(200, '<!DOCTYPE html>'), { url: 'u', wrap: (m) => new Mine(m) }),
    ).rejects.toBeInstanceOf(Mine);
  });
});

describe('fetchOrExplain', () => {
  it('wraps a transport failure and leaves everything else alone', async () => {
    class Mine extends Error {}
    vi.stubGlobal('fetch', vi.fn(async () => { throw transport('ENOTFOUND'); }));
    await expect(
      fetchOrExplain('https://h', {}, { host: 'https://h', wrap: (m) => new Mine(m) }),
    ).rejects.toBeInstanceOf(Mine);

    const other = new RangeError('not transport');
    vi.stubGlobal('fetch', vi.fn(async () => { throw other; }));
    await expect(
      fetchOrExplain('https://h', {}, { host: 'https://h', wrap: (m) => new Mine(m) }),
    ).rejects.toBe(other);
    vi.unstubAllGlobals();
  });
});

describe('normalizeServiceUrl', () => {
  const wrap = (m: string) => new Error(m);

  it('reads a bare host as https and keeps a subpath', () => {
    expect(normalizeServiceUrl('example.com', wrap)).toBe('https://example.com');
    expect(normalizeServiceUrl('https://example.com/gitlab/', wrap)).toBe('https://example.com/gitlab');
    expect(normalizeServiceUrl('http://host:8080', wrap)).toBe('http://host:8080');
  });

  it('refuses what it cannot use', () => {
    expect(() => normalizeServiceUrl('ftp://example.com', wrap)).toThrow(/only http and https/);
    expect(() => normalizeServiceUrl('  ', wrap)).toThrow(/No URL/);
  });
});

describe('the rule this module exists to make checkable', () => {
  it('is the only place in apps/api that calls fetch directly', () => {
    // Grep is the enforcement. A new integration that calls `fetch` itself
    // re-opens the class, and this is what says so at review time rather than
    // after a user reports a doctype.
    // Walked from disk rather than `git grep`, which only sees tracked files —
    // a new integration would be untracked exactly when this test matters.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const hits: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          // The headless end-to-end script is a client of specd's own API, not
          // an outbound integration, and it is not served to anyone.
          entry.name !== 'e2e-loop.ts'
        ) {
          if (/(await |= )fetch\(/.test(readFileSync(full, 'utf8'))) hits.push(full);
        }
      }
    };
    walk(root);

    expect(hits.map((h) => h.slice(root.length))).toEqual(['common/http-failures.ts']);
  });
});
