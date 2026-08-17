import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from '@specd/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config.js';
import type { VcsService } from './vcs.service.js';
import { WorkspaceService } from './workspace.js';

/**
 * The local build workspace against a real repository.
 *
 * `createLocal` reads nothing from `VcsService` — only hosted clones need a
 * token — so the service is constructed with a config alone. PR opening stays
 * off: this is about the branch a build starts from, not about publishing it.
 */
describe('WorkspaceService.create — local', () => {
  let root = '';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' as const });

  const service = new WorkspaceService(null as unknown as VcsService, {
    localOpenPr: false,
  } as Config);

  const repo = () => ({ provider: 'local', name: 'acme/api', localPath: root }) as Repository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'specd-workspace-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    writeFileSync(join(root, 'README.md'), '# x\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('starts a build on its own branch, cut from the current tip', async () => {
    const ws = await service.create(repo(), 'spec/E-101-add-csv-export');
    try {
      expect(ws.branch).toBe('spec/E-101-add-csv-export');
      expect(ws.baseBranch).toBe('main');
      expect(
        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: ws.dir,
          encoding: 'utf8',
        }).trim(),
      ).toBe('spec/E-101-add-csv-export');
    } finally {
      await ws.dispose();
    }
  });

  it('re-runs from a clean branch instead of stacking on the last attempt', async () => {
    // The regression this pins: a second build of the same spec used to check
    // out the branch the first one left, so its PR carried both attempts.
    const first = await service.create(repo(), 'spec/E-101-add-csv-export');
    writeFileSync(join(first.dir, 'attempt.txt'), 'one\n');
    execFileSync('git', ['add', '-A'], { cwd: first.dir });
    execFileSync('git', ['commit', '-qm', 'first attempt'], { cwd: first.dir });
    await first.dispose();

    const second = await service.create(repo(), 'spec/E-101-add-csv-export');
    try {
      const log = execFileSync('git', ['log', '--oneline', 'main..HEAD'], {
        cwd: second.dir,
        encoding: 'utf8',
      });
      expect(log.trim()).toBe('');
      expect(log).not.toContain('first attempt');
    } finally {
      await second.dispose();
    }
  });
});
