import { describe, expect, it } from 'vitest';
import { describeStack, detectStack } from './stack.js';
import { renderAgentsMd } from './agents-md.js';
import { renderScaffold, renderSetupPrBody } from './knowledge.js';
import { collectEvidence } from './evidence.js';

const noEvidence = collectEvidence({ files: [], samples: [] });

function pkg(body: Record<string, unknown>) {
  return [{ path: 'package.json', content: JSON.stringify(body) }];
}

describe('stack detection', () => {
  it('detects a NestJS service and builds its verify command', () => {
    const stack = detectStack(
      pkg({
        packageManager: 'pnpm@10.0.0',
        dependencies: { '@nestjs/core': '^11', typeorm: '^0.3' },
        devDependencies: { jest: '^29', eslint: '^9', typescript: '^5' },
        scripts: { lint: 'eslint src', typecheck: 'tsc --noEmit', test: 'jest' },
      }),
      ['package.json', 'tsconfig.json', 'pnpm-lock.yaml', 'src/main.ts'],
    );

    expect(stack.language).toBe('TypeScript');
    expect(stack.framework).toBe('NestJS');
    expect(stack.packageManager).toBe('pnpm');
    expect(stack.testRunner).toBe('Jest');
    expect(stack.verifyCommand).toBe('pnpm lint && pnpm typecheck && pnpm test');
    expect(stack.extras).toContain('TypeORM');
  });

  it('infers the package manager from a lockfile when none is declared', () => {
    const stack = detectStack(pkg({ dependencies: { next: '^15' } }), [
      'package.json',
      'yarn.lock',
    ]);
    expect(stack.framework).toBe('Next.js');
    expect(stack.packageManager).toBe('yarn');
  });

  it('reports JavaScript when there is no tsconfig', () => {
    const stack = detectStack(pkg({ dependencies: { express: '^4' } }), ['package.json']);
    expect(stack.language).toBe('JavaScript');
    expect(stack.framework).toBe('Express');
  });

  it('survives a malformed package.json instead of throwing', () => {
    const stack = detectStack([{ path: 'package.json', content: '{ not json' }], [
      'package.json',
    ]);
    expect(stack.language).toBe('JavaScript');
    expect(stack.framework).toBeUndefined();
  });

  it('detects non-node stacks', () => {
    expect(detectStack([], ['go.mod', 'main.go']).language).toBe('Go');
    expect(detectStack([], ['Cargo.toml']).language).toBe('Rust');
    expect(detectStack([], ['Gemfile']).language).toBe('Ruby');
    expect(detectStack([], ['main.tf', 'variables.tf']).language).toBe('Terraform');
    expect(detectStack([], ['pom.xml']).language).toBe('Java/Kotlin');
  });

  it('detects a Django project from pyproject', () => {
    const stack = detectStack(
      [{ path: 'pyproject.toml', content: '[tool.poetry.dependencies]\ndjango = "^5.0"\npytest = "*"' }],
      ['pyproject.toml', 'poetry.lock', 'manage.py'],
    );
    expect(stack.language).toBe('Python');
    expect(stack.framework).toBe('Django');
    expect(stack.packageManager).toBe('poetry');
  });

  it('says "unknown" rather than guessing when it sees nothing it recognises', () => {
    const stack = detectStack([], ['README.md', 'notes.txt']);
    expect(stack.language).toBe('unknown');
    expect(stack.verifyCommand).toBeUndefined();
    expect(describeStack(stack)).toBe('unknown');
  });
});

describe('generated artifacts', () => {
  const stack = detectStack(
    pkg({ dependencies: { '@nestjs/core': '^11' }, scripts: { test: 'jest' } }),
    ['package.json', 'tsconfig.json'],
  );

  it('renders the working agreements verbatim', () => {
    const md = renderAgentsMd({
      repoName: 'aurora-api',
      stack,
      isPrimary: true,
      projectName: 'Aurora CRM',
    });

    // These lines are the product. If they drift, the guarantee drifts.
    expect(md).toContain('Before implementing ANYTHING, read knowledge/README.md');
    expect(md).toContain('cite the file you relied on');
    expect(md).toContain('Update knowledge/ IN THE SAME PR');
    expect(md).toContain('Never rewrite old');
    expect(md).toContain('specd spec pull <id>');
    expect(md).toContain('one task ≤ one PR');
    expect(md).toContain('commit the as-built spec');
    expect(md).toContain('query them before reading');
  });

  it('wires the knowledge tools it just told the agent to prefer', () => {
    const md = renderAgentsMd({
      repoName: 'aurora-api',
      stack,
      isPrimary: true,
      projectName: 'Aurora CRM',
    });

    // Rule 8 without the config is advice; the config without rule 8 is
    // trivia. Landing one of the two alone is the way this stops working.
    expect(md).toContain('query them before reading');
    expect(md).toContain('"command": "specd", "args": ["mcp", "serve"]');
    expect(md).toContain('search_knowledge');
    // The read-only guarantee travels with the instructions, because an
    // agent that thinks it can approve its own spec will try.
    expect(md).toContain('read-only');
  });

  it('tells a non-primary repo where the as-built spec goes', () => {
    const md = renderAgentsMd({
      repoName: 'aurora-web',
      stack,
      isPrimary: false,
      projectName: 'Aurora CRM',
    });
    expect(md).toContain('the primary repo of Aurora CRM');
  });

  it('marks undetected facts rather than inventing them', () => {
    const bare = detectStack([], ['README.md']);
    const md = renderAgentsMd({
      repoName: 'mystery',
      stack: bare,
      isPrimary: true,
      projectName: 'X',
    });
    expect(md).toContain('not detected — please fill in');
  });

  it('scaffolds both rule files and the full knowledge tree', () => {
    const files = renderScaffold({
      repoName: 'aurora-api',
      projectName: 'Aurora CRM',
      isPrimary: true,
      stack,
      evidence: collectEvidence({ files: ['src/main.ts', 'test/a.test.ts'], samples: [] }),
      date: '2026-08-06',
      agentsMd: renderAgentsMd({ repoName: 'aurora-api', stack, isPrimary: true, projectName: 'X' }),
    });

    const paths = files.map((f) => f.path);
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('knowledge/README.md');
    expect(paths).toContain('knowledge/product.md');
    expect(paths).toContain('knowledge/architecture.md');
    expect(paths).toContain('knowledge/conventions.md');
    expect(paths).toContain('knowledge/testing.md');
    expect(paths).toContain('knowledge/glossary.md');
    expect(paths).toContain('knowledge/open-questions.md');
    expect(paths).toContain('knowledge/decisions/README.md');
    expect(paths).toContain('knowledge/decisions/0001-adopt-spec-driven.md');
    expect(paths).toContain('knowledge/runbooks/local-dev.md');
    expect(paths).toContain('knowledge/specs/README.md');
    expect(paths).toContain('knowledge/specs/TEMPLATE.md');
  });

  it('asks the question instead of filling a section it has no draft for', () => {
    const files = renderScaffold({
      repoName: 'aurora-api',
      projectName: 'Aurora CRM',
      isPrimary: true,
      stack,
      evidence: noEvidence,
      date: '2026-08-06',
      agentsMd: 'RULES',
    });

    const product = files.find((f) => f.path === 'knowledge/product.md')!.content;
    expect(product).toContain('UNVERIFIED — state the job this system does');

    // And the gap becomes a work item rather than sitting silently in a doc.
    const questions = files.find((f) => f.path === 'knowledge/open-questions.md')!.content;
    expect(questions).toContain('What is this system for');
    expect(questions).toContain('How is a change verified before it merges?');
  });

  it('makes CLAUDE.md a pointer, so editing one file keeps both in sync', () => {
    const files = renderScaffold({
      repoName: 'r',
      projectName: 'p',
      isPrimary: true,
      stack,
      evidence: noEvidence,
      date: '2026-08-06',
      agentsMd: 'RULES',
    });
    const claude = files.find((f) => f.path === 'CLAUDE.md')!;
    expect(claude.content).toContain('@AGENTS.md');
    expect(claude.content).not.toContain('Knowledge first');
  });

  it('banners every generated doc as a draft', () => {
    const files = renderScaffold({
      repoName: 'r',
      projectName: 'p',
      isPrimary: true,
      stack,
      evidence: noEvidence,
      date: '2026-08-06',
      agentsMd: 'RULES',
    });
    for (const file of files.filter((f) => f.path.startsWith('knowledge/') && !f.path.includes('specs/') && !f.path.includes('decisions/'))) {
      expect(file.content, file.path).toContain('DRAFT — review before trusting');
    }
  });

  it('says out loud what the drafts are worth in the PR body', () => {
    const body = renderSetupPrBody({
      repoName: 'aurora-api',
      projectName: 'Aurora CRM',
      fileCount: 10,
      unverifiedCount: 7,
      stackLine: 'NestJS · TypeScript',
      evidence: noEvidence,
      drafted: true,
    });
    expect(body).toContain('review me, then merge to adopt');
    expect(body).toContain('it cannot see your intent');
    expect(body).toContain('**7**');
    expect(body).toContain('Do not treat generated text as verified');
    expect(body).toContain('Merging is adopting');
  });

  it('says so when no model drafted anything, rather than implying one did', () => {
    const body = renderSetupPrBody({
      repoName: 'aurora-api',
      projectName: 'Aurora CRM',
      fileCount: 10,
      unverifiedCount: 22,
      stackLine: 'NestJS · TypeScript',
      evidence: noEvidence,
      drafted: false,
    });
    expect(body).toContain('No AI credential was available');
  });
});
