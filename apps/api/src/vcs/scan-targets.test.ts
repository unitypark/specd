import { describe, expect, it } from 'vitest';
import { collectSamples, isSensitivePath, selectScanTargets } from './scan-targets.js';

const paths = (files: string[]) => selectScanTargets(files).map((t) => t.path);

describe('choosing what an onboarding scan opens', () => {
  it('reads the files that answer the questions the docs ask', () => {
    const chosen = paths([
      'package.json',
      'README.md',
      '.github/workflows/ci.yml',
      'docker-compose.yml',
      '.env.example',
      'apps/api/package.json',
      'packages/db/src/schema.ts',
      'db/migrations/0001_init.sql',
      'docs/runners.md',
      'src/main.ts',
      'src/some/deep/module.ts',
    ]);

    expect(chosen).toContain('package.json');
    expect(chosen).toContain('.github/workflows/ci.yml');
    expect(chosen).toContain('docker-compose.yml');
    expect(chosen).toContain('.env.example');
    expect(chosen).toContain('apps/api/package.json');
    expect(chosen).toContain('packages/db/src/schema.ts');
    expect(chosen).toContain('db/migrations/0001_init.sql');
    expect(chosen).toContain('docs/runners.md');
    expect(chosen).toContain('src/main.ts');

    // Ordinary source is still out of scope — this is a selector, not a crawler.
    expect(chosen).not.toContain('src/some/deep/module.ts');
  });

  it('never opens a secret, however it matches', () => {
    const secrets = [
      '.env',
      '.env.production',
      'config/credentials.json',
      'certs/server.pem',
      'deploy/id_rsa',
      'terraform.tfvars',
    ];
    for (const path of secrets) expect(isSensitivePath(path), path).toBe(true);

    expect(paths([...secrets, '.env.example', 'package.json']).sort()).toEqual([
      '.env.example',
      'package.json',
    ]);
  });

  it('caps each tier so one noisy kind cannot crowd out the others', () => {
    const monorepo = [
      'package.json',
      '.github/workflows/ci.yml',
      ...Array.from({ length: 80 }, (_, i) => `packages/p${i}/package.json`),
    ];

    const chosen = paths(monorepo);
    const workspaceManifests = chosen.filter((p) => p.startsWith('packages/'));

    expect(workspaceManifests).toHaveLength(12);
    expect(chosen).toContain('.github/workflows/ci.yml');
  });

  it('is deterministic and prefers shallow manifests to deep ones', () => {
    const files = ['package.json', 'apps/web/plugins/package.json', 'apps/api/package.json'];
    const chosen = paths(files);

    expect(chosen).toEqual(paths(files));
    expect(chosen.indexOf('apps/api/package.json')).toBeLessThan(
      chosen.indexOf('apps/web/plugins/package.json'),
    );

    // And a manifest buried past the workspace depth is not a workspace.
    expect(paths(['apps/web/a/b/c/package.json'])).toEqual([]);
  });

  it('skips ignored directories entirely', () => {
    expect(paths(['node_modules/foo/package.json', 'dist/index.js', 'package.json'])).toEqual([
      'package.json',
    ]);
  });
});

describe('reading the chosen files', () => {
  it('truncates each file to its tier budget', async () => {
    const samples = await collectSamples(['README.md', '.github/workflows/ci.yml'], async (t) => ({
      path: t.path,
      content: 'x'.repeat(100_000),
    }));

    const readme = samples.find((s) => s.path === 'README.md')!;
    const workflow = samples.find((s) => s.path === '.github/workflows/ci.yml')!;

    expect(readme.content).toHaveLength(40_000);
    expect(workflow.content).toHaveLength(8_000);
  });

  it('drops a file it cannot read instead of failing the whole scan', async () => {
    const samples = await collectSamples(['package.json', 'README.md'], async (t) => {
      if (t.path === 'README.md') throw new Error('403');
      return { path: t.path, content: '{}' };
    });

    expect(samples.map((s) => s.path)).toEqual(['package.json']);
  });

  it('reads concurrently without losing or reordering anything', async () => {
    const files = Array.from({ length: 40 }, (_, i) => `packages/p${i}/package.json`);
    const samples = await collectSamples([...files, 'package.json'], async (t) => ({
      path: t.path,
      content: t.path,
    }));

    expect(samples.map((s) => s.path)).toEqual(selectScanTargets([...files, 'package.json']).map((t) => t.path));
  });
});
