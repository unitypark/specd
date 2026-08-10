import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './claude.js';

/**
 * Regression test for the hang this fixed: a killed child can leave its
 * stdio pipes open if a grandchild inherited them, so `close` never fires.
 * The fake `claude` here reproduces exactly that — it backgrounds a
 * long-lived process that inherits its stdout/stderr and exits immediately
 * itself, so `exit` fires fast but `close` would never come on its own.
 */
describe('exec()', () => {
  let fakeBinDir: string;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    fakeBinDir = await mkdtemp(join(tmpdir(), 'specd-fake-claude-'));
    process.env.PATH = `${fakeBinDir}:${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(fakeBinDir, { recursive: true, force: true });
  });

  it('resolves via the backstop instead of hanging when close never fires', async () => {
    await writeFile(
      join(fakeBinDir, 'claude'),
      '#!/bin/sh\n(sleep 30 &)\nexit 0\n',
      { mode: 0o755 },
    );

    const start = Date.now();
    const result = await exec(['--version'], '', 200, process.cwd());
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Bounded by the soft timeout + kill grace + give-up backstop — never
    // the 30s the orphaned grandchild actually keeps the pipe open for.
    expect(elapsed).toBeLessThan(20_000);
  }, 25_000);

  it('survives a child that exits before reading its prompt', async () => {
    // The pipe has nowhere to go, so the write fails with EPIPE — on stdin,
    // which is a different emitter from the child. Unhandled it takes the
    // daemon down; the prompt is large enough here that the write cannot
    // slip into the pipe buffer and win the race by luck.
    await writeFile(join(fakeBinDir, 'claude'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });

    const result = await exec(['--version'], 'x'.repeat(2_000_000), 5_000, process.cwd());

    // The child's own outcome is the answer, not the broken pipe.
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('resolves immediately and untouched by the backstop on a normal, fast exit', async () => {
    await writeFile(join(fakeBinDir, 'claude'), '#!/bin/sh\necho hi\nexit 0\n', { mode: 0o755 });

    const result = await exec(['--version'], '', 5_000, process.cwd());

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });
});
