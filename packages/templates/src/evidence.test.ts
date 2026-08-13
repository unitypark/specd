import { describe, expect, it } from 'vitest';
import { collectEvidence, hasDataEvidence, hasIntegrationEvidence } from './evidence.js';

/**
 * The evidence pass is what decides whether a generated knowledge base reads
 * like a description of this repository or like a description of any
 * repository. Everything asserted here ends up in a doc *unmarked*, so a wrong
 * answer is worse than no answer — these tests are the contract for that.
 */

const workflow = `name: CI
on:
  push:
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: |
          pnpm typecheck && pnpm test
      - name: Build
        run: pnpm build
`;

const compose = `services:
  db:
    image: pgvector/pgvector:pg17
    ports:
      - "5433:5432"
    environment:
      POSTGRES_PASSWORD: dev
  cache:
    image: redis:7
`;

const envExample = `# Postgres connection string
DATABASE_URL=postgres://localhost:5433/app

# Billing
STRIPE_API_KEY=
export SLACK_WEBHOOK_SECRET=
`;

describe('reading a repository instead of guessing at it', () => {
  it('reads the commands a repo declares, with the file each came from', () => {
    const evidence = collectEvidence({
      files: ['package.json', 'Makefile'],
      samples: [
        {
          path: 'package.json',
          content: JSON.stringify({
            packageManager: 'pnpm@10.32.1',
            scripts: { test: 'vitest run', dev: 'nest start --watch' },
          }),
        },
        { path: 'Makefile', content: '.PHONY: seed\nseed:\n\tnode seed.js\n' },
      ],
    });

    expect(evidence.scripts).toContainEqual({
      name: 'pnpm test',
      command: 'vitest run',
      source: 'package.json',
    });
    expect(evidence.scripts.map((s) => s.name)).toContain('make seed');
    // `.PHONY` is a directive, not a target anyone runs.
    expect(evidence.scripts.map((s) => s.name)).not.toContain('make .PHONY');
  });

  it('pulls the real verify steps out of a CI workflow, block scalars included', () => {
    const evidence = collectEvidence({
      files: ['.github/workflows/ci.yml'],
      samples: [{ path: '.github/workflows/ci.yml', content: workflow }],
    });

    expect(evidence.ci).toHaveLength(1);
    expect(evidence.ci[0]!.name).toBe('CI');
    expect(evidence.ci[0]!.triggers).toEqual(['push', 'pull_request']);
    expect(evidence.ci[0]!.commands).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm typecheck && pnpm test',
      'pnpm build',
    ]);
  });

  it('reads the services that must be up, and what they are', () => {
    const evidence = collectEvidence({
      files: ['docker-compose.yml'],
      samples: [{ path: 'docker-compose.yml', content: compose }],
    });

    expect(evidence.services).toEqual([
      { name: 'db', image: 'pgvector/pgvector:pg17', ports: ['5433:5432'], source: 'docker-compose.yml' },
      { name: 'cache', image: 'redis:7', ports: [], source: 'docker-compose.yml' },
    ]);
    expect(evidence.dataStores).toContain('PostgreSQL (docker-compose.yml)');
  });

  it('keeps the comment above a configuration variable — usually its only doc', () => {
    const evidence = collectEvidence({
      files: ['.env.example'],
      samples: [{ path: '.env.example', content: envExample }],
    });

    expect(evidence.envVars).toContainEqual({
      name: 'DATABASE_URL',
      note: 'Postgres connection string',
      source: '.env.example',
    });
    // `export FOO=` is still a variable.
    expect(evidence.envVars.map((v) => v.name)).toContain('SLACK_WEBHOOK_SECRET');
  });

  it('names entities in whichever way the repo declares them', () => {
    const evidence = collectEvidence({
      files: ['db/schema.ts', 'prisma/schema.prisma', 'db/migrate/001.sql'],
      samples: [
        { path: 'db/schema.ts', content: "export const runs = pgTable('agent_runs', {});" },
        { path: 'prisma/schema.prisma', content: 'model Invoice {\n  id Int @id\n}\n' },
        { path: 'db/migrate/001.sql', content: 'CREATE TABLE IF NOT EXISTS ledger_entries (id int);' },
      ],
    });

    const names = evidence.entities.map((e) => e.name);
    expect(names).toContain('agent_runs');
    expect(names).toContain('Invoice');
    expect(names).toContain('ledger_entries');
    expect(evidence.entities.find((e) => e.name === 'Invoice')!.source).toBe('prisma/schema.prisma');
    expect(hasDataEvidence(evidence)).toBe(true);
  });

  it('finds outbound integrations from dependencies and from configuration', () => {
    const evidence = collectEvidence({
      files: ['package.json', '.env.example'],
      samples: [
        { path: 'package.json', content: JSON.stringify({ dependencies: { stripe: '^17' } }) },
        { path: '.env.example', content: 'SENDGRID_API_KEY=\n' },
      ],
    });

    expect(evidence.integrations.map((i) => i.name)).toEqual(['Stripe', 'Sendgrid']);
    expect(hasIntegrationEvidence(evidence)).toBe(true);
  });

  it('reports an empty repo as empty rather than inventing structure', () => {
    const evidence = collectEvidence({ files: ['README.md'], samples: [] });

    expect(evidence.scripts).toEqual([]);
    expect(evidence.ci).toEqual([]);
    expect(evidence.tests.fileCount).toBe(0);
    expect(hasDataEvidence(evidence)).toBe(false);
    expect(hasIntegrationEvidence(evidence)).toBe(false);
  });

  it('describes the test layout in the shapes people actually use', () => {
    const evidence = collectEvidence({
      files: [
        'src/a.ts',
        'src/a.test.ts',
        'src/b.test.ts',
        'internal/pool_test.go',
        'tests/test_invoices.py',
      ],
      samples: [
        { path: 'package.json', content: JSON.stringify({ devDependencies: { vitest: '^2' } }) },
      ],
    });

    expect(evidence.tests.fileCount).toBe(4);
    expect(evidence.tests.frameworks).toContain('Vitest');
    expect(evidence.tests.frameworks).toContain('go test');
    expect(evidence.tests.dirs[0]).toBe('src');
  });

  it('notices agent instructions the repo already has', () => {
    const evidence = collectEvidence({
      files: ['AGENTS.md', '.cursorrules', 'docs/runners.md'],
      samples: [],
    });

    expect(evidence.existingAgentDocs).toEqual(['AGENTS.md', '.cursorrules']);
    // An existing instruction file is not a doc to link — it is a conflict to resolve.
    expect(evidence.docs).toEqual(['docs/runners.md']);
  });
});
