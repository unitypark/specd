import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { CLI_ALLOWED_KEY } from '../auth/auth.guard.js';
import { CliController } from './cli.controller.js';

/**
 * `@CliAllowed` on the class is what lets a CLI-audience token reach anything
 * here at all — and it applies to every route on the controller, including the
 * next one somebody adds. That is the lever the MCP server's read-only
 * guarantee rests on (0017), and it is also the way to lose it by accident:
 * a `@Post` added here is reachable by every paired machine the moment it
 * merges, with no other review step that would notice.
 *
 * So the invariant is asserted rather than remembered.
 */
describe('the CLI surface', () => {
  const proto = CliController.prototype as unknown as Record<string, () => unknown>;
  const handlers = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => ({
      name,
      method: Reflect.getMetadata(METHOD_METADATA, proto[name]!) as RequestMethod | undefined,
      path: Reflect.getMetadata(PATH_METADATA, proto[name]!) as string | undefined,
    }))
    .filter((h) => h.method !== undefined);

  it('is reachable by CLI tokens at all', () => {
    expect(Reflect.getMetadata(CLI_ALLOWED_KEY, CliController)).toBe(true);
  });

  it('exposes exactly one route that is not a read', () => {
    const writes = handlers.filter((h) => h.method !== RequestMethod.GET);

    // `connect` registers a local repository, and it is the single deliberate
    // exception — a machine saying "this checkout is here" is the one write a
    // thin client is trusted with. Anything else appearing in this list means
    // the CLI just grew the ability to change something, which is exactly what
    // D13 says it must never have. Do not widen this test to make a new route
    // pass; move the route off this controller instead.
    expect(writes.map((h) => h.name)).toEqual(['connect']);
  });

  it('serves the knowledge engine to agents, read-only', () => {
    const knowledge = handlers
      .filter((h) => (h.path ?? '').includes('knowledge'))
      .map((h) => ({ name: h.name, isGet: h.method === RequestMethod.GET }));

    expect(knowledge.map((k) => k.name).sort()).toEqual([
      'doc',
      'knowledgeHealth',
      'search',
      'verify',
    ]);
    expect(knowledge.every((k) => k.isGet)).toBe(true);
  });

  it('keeps the gate on the pull route, not in the client', () => {
    // `pull` exists here so the refusal is server-side. If it ever stopped
    // being a route on this controller, every CLI and every MCP client would
    // be free to fetch an unapproved spec.
    expect(handlers.find((h) => h.name === 'pull')?.path).toBe(
      'projects/:slug/specs/:ref/pull',
    );
  });
});
