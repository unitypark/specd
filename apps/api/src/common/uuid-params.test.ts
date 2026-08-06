import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every uuid path parameter must be validated at the boundary.
 *
 * Without a pipe, a malformed id reaches Postgres and comes back as
 * `PostgresError: invalid input syntax for type uuid`, which Nest surfaces as
 * a 500. That is wrong twice over: the caller's mistake is reported as our
 * failure, and a driver-level error message is leaked to them.
 *
 * This is asserted over the source because it is a property of every route,
 * not of any one handler — a new controller with an unguarded `:specId` should
 * fail here rather than in production.
 */

const CONTROLLERS = [
  'board/board.controller.ts',
  'projects/projects.controller.ts',
  'vcs/github.controller.ts',
  'runs/runs.controller.ts',
  'cli/cli.controller.ts',
];

/** Params that are always uuids. `:ref` and `:slug` deliberately are not. */
const UUID_PARAMS = ['ticketId', 'specId', 'repoId', 'docId', 'projectId', 'runId'];

const sources = CONTROLLERS.map((rel) => ({
  name: rel,
  code: readFileSync(join(import.meta.dirname, '..', rel), 'utf8'),
}));

describe('uuid path parameters', () => {
  it('are all guarded by ParseUUIDPipe', () => {
    const unguarded: string[] = [];
    for (const { name, code } of sources) {
      for (const param of UUID_PARAMS) {
        // `@Param('specId')` with no pipe after it.
        const bare = new RegExp(`@Param\\('${param}'\\)`, 'g');
        if (bare.test(code)) unguarded.push(`${name} → ${param}`);
      }
    }
    expect(unguarded, `unguarded uuid params reach Postgres and 500`).toEqual([]);
  });

  it('leaves flexible references alone', () => {
    // `specd spec pull CRM-142` passes a ticket key, not a uuid. Validating
    // that param as a uuid would break the CLI's entire read path.
    const cli = sources.find((s) => s.name.includes('cli'))!;
    expect(cli.code).toContain(":ref/pull");
    expect(cli.code).not.toContain('ParseUUIDPipe');
  });

  it('never guards the project slug', () => {
    // Slugs are human-readable ("aurora-crm"), never uuids.
    for (const { name, code } of sources) {
      expect(code, `${name} must not uuid-validate :slug`).not.toContain(
        "@Param('slug', ParseUUIDPipe)",
      );
    }
  });
});
