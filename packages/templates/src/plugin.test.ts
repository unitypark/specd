import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Claude Code plugin lives at the repo root, not in this package — but it
 * ships the same rules `renderAgentsMd` writes, in executable form, so it is
 * tested beside them. A skill that drifts from AGENTS.md is the failure this
 * file exists to catch.
 */
const repoRoot = resolve(import.meta.dirname, '../../..');
const pluginDir = join(repoRoot, 'plugins');
const gate = join(pluginDir, 'hooks', 'gate.sh');
const docsRide = join(pluginDir, 'hooks', 'docs-ride-the-change.sh');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('the plugin manifests', () => {
  it('registers the plugin in a marketplace that points at it', () => {
    const marketplace = readJson(join(repoRoot, '.claude-plugin', 'marketplace.json'));
    const plugins = marketplace.plugins as { name: string; source: string }[];
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.name).toBe('specd');
    // The source has to resolve, or `/plugin install` fails on a path nobody
    // checked: the marketplace sits at the repo root and the plugin one down.
    expect(plugins[0]!.source).toBe('./plugins');
  });

  it('declares only skills and hooks that exist on disk', () => {
    const manifest = readJson(join(pluginDir, '.claude-plugin', 'plugin.json'));
    expect(manifest.name).toBe('specd');

    const hooksPath = join(pluginDir, String(manifest.hooks).replace('./', ''));
    const hooks = readJson(hooksPath).hooks as Record<
      string,
      { hooks: { command: string }[] }[]
    >;
    // Every hook command must name a file that is actually here. ${CLAUDE_PLUGIN_ROOT}
    // is substituted by the host, so resolve it the way the host would.
    for (const matchers of Object.values(hooks)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          const script = hook.command.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir);
          expect(() => readFileSync(script, 'utf8')).not.toThrow();
        }
      }
    }
  });

  it('gives every skill the frontmatter the loader needs', () => {
    for (const name of ['pull', 'implement', 'as-built']) {
      const body = readFileSync(join(pluginDir, 'skills', name, 'SKILL.md'), 'utf8');
      expect(body.startsWith('---\n')).toBe(true);
      expect(body).toMatch(new RegExp(`^name: ${name}$`, 'm'));
      // The description is what the model matches a request against; an empty
      // one makes the skill unreachable without anyone noticing.
      expect(body).toMatch(/^description: \S.{40,}$/m);
    }
  });
});

/**
 * The hooks are the half that can break someone's editing session, so they are
 * tested against a real git repository with a real branch name and a stubbed
 * `specd` on PATH. Exit 2 is Claude Code's "block this call"; 0 is "carry on".
 */
describe('the gate hook', () => {
  let dir: string;
  let binDir: string;

  const run = (branch: string, stub: string | null, env: Record<string, string> = {}) => {
    execFileSync('git', ['switch', '-C', branch], { cwd: dir, stdio: 'ignore' });
    if (stub === null) {
      rmSync(join(binDir, 'specd'), { force: true });
    } else {
      writeFileSync(join(binDir, 'specd'), stub, { mode: 0o755 });
    }
    return spawnSync('sh', [gate], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        // A fresh cache per case: the hook remembers an approved verdict for a
        // minute, which would otherwise let one case answer the next.
        TMPDIR: mkdtempSync(join(tmpdir(), 'specd-hook-cache-')),
        ...env,
      },
    });
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'specd-gate-'));
    binDir = join(dir, 'bin');
    mkdirSync(binDir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
      { cwd: dir },
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('blocks an edit when the server says the spec is not approved', () => {
    const res = run('spec/crm-1-add-widget', '#!/bin/sh\nexit 3\n');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('CRM-1 is not approved');
  });

  it('passes the ticket key through, hyphen and all', () => {
    // The key is CRM-1, not CRM: specBranchName() lowercases a key that already
    // contains a hyphen, so splitting on the first one loses the number.
    const res = run('spec/crm-1-add-widget', '#!/bin/sh\necho "$@" >&2\nexit 3\n');
    expect(res.stderr).toContain('CRM-1');
    expect(res.stderr).not.toContain('spec status crm\n');
  });

  it('lets an approved spec through', () => {
    const res = run('spec/s-104-cli-repl', '#!/bin/sh\nexit 0\n');
    expect(res.status).toBe(0);
  });

  it('has no opinion about branches that are not spec work', () => {
    const res = run('feat/whatever', '#!/bin/sh\nexit 3\n');
    expect(res.status).toBe(0);
  });

  it('fails open when specd is not installed', () => {
    const res = run('spec/crm-1-add-widget', null);
    expect(res.status).toBe(0);
  });

  it('fails open when specd errors — not logged in, no project, server down', () => {
    const res = run('spec/crm-1-add-widget', '#!/bin/sh\necho "not logged in" >&2\nexit 1\n');
    expect(res.status).toBe(0);
  });
});

describe('the docs-ride-the-change hook', () => {
  let dir: string;

  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, body] of Object.entries(files)) {
      const full = join(dir, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message],
      { cwd: dir },
    );
  };

  const run = (stopHookActive = false) =>
    spawnSync('sh', [docsRide], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({ stop_hook_active: stopHookActive }),
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'specd-docs-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    commit({ 'README.md': '# fixture\n' }, 'init');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('asks when a spec branch changed code and no knowledge doc', () => {
    execFileSync('git', ['switch', '-qC', 'spec/crm-1-widget'], { cwd: dir });
    commit({ 'src/widget.ts': 'export const widget = 1;\n' }, 'add widget');
    const res = run();
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('rule 3');
  });

  it('says nothing once the knowledge doc rides along', () => {
    commit({ 'knowledge/architecture.md': '# arch\n\nThe widget.\n' }, 'document widget');
    expect(run().status).toBe(0);
  });

  it('asks only once, so a considered answer can end the turn', () => {
    // Off main, not off the previous spec branch: branching from a branch that
    // already documented itself would inherit its knowledge/ change and make
    // this pass for the wrong reason.
    execFileSync('git', ['switch', '-q', 'main'], { cwd: dir });
    execFileSync('git', ['switch', '-qC', 'spec/crm-2-other'], { cwd: dir });
    commit({ 'src/other.ts': 'export const other = 2;\n' }, 'add other');
    expect(run().status).toBe(2);
    // stop_hook_active means this already fired and the agent chose to stop.
    expect(run(true).status).toBe(0);
  });

  it('has no opinion about branches that are not spec work', () => {
    execFileSync('git', ['switch', '-q', 'main'], { cwd: dir });
    expect(run().status).toBe(0);
  });
});
