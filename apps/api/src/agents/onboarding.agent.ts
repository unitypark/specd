import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { repositories, type Db, type Repository } from '@specd/db';
import {
  detectStack,
  describeStack,
  renderAgentsMd,
  renderScaffold,
  renderSetupPrBody,
  type DetectedStack,
} from '@specd/templates';
import type { ModelId } from '@specd/shared';
import { DB } from '../db/db.module.js';
import { VcsService } from '../vcs/vcs.service.js';
import { IGNORED_DIRS, type RepoSnapshot } from '../vcs/vcs.types.js';
import { AnthropicService } from './anthropic.service.js';
import type { RunHandle } from '../runs/runs.service.js';

/** What we ask the model for. Everything else is rendered from templates. */
interface DraftedDocs {
  architecture: string;
  conventions: string;
  glossaryTerms: { term: string; meaning: string }[];
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    architecture: {
      type: 'string',
      description:
        'Markdown body for knowledge/architecture.md, without the H1 title and without the DRAFT banner.',
    },
    conventions: {
      type: 'string',
      description:
        'Markdown body for knowledge/conventions.md, without the H1 title and without the DRAFT banner.',
    },
    glossaryTerms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          meaning: { type: 'string' },
        },
        required: ['term', 'meaning'],
        additionalProperties: false,
      },
    },
  },
  required: ['architecture', 'conventions', 'glossaryTerms'],
  additionalProperties: false,
} as const;

/**
 * The onboarding agent — station 02, Ground.
 *
 * Its whole job is to produce a *reviewable* first draft of a repo's knowledge
 * base. The hard constraint, and the reason the prompt is written the way it
 * is: it must never present inference as fact. A confident wrong architecture
 * doc poisons every spec that retrieves it afterwards (§15, the frozen-table
 * incident), so unverifiable claims are marked, not smoothed over.
 */
@Injectable()
export class OnboardingAgent {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vcs: VcsService,
    private readonly anthropic: AnthropicService,
  ) {}

  async run(input: {
    repo: Repository;
    projectName: string;
    apiKey: string | null;
    model: ModelId;
    run: RunHandle;
  }): Promise<{ branch: string; url: string | null; reviewHint: string; fileCount: number }> {
    const { repo, projectName, apiKey, model, run } = input;

    await run.log(`clone (read-only) · ${repo.name}`);
    const adapter = await this.vcs.adapterFor(repo);
    const target = this.vcs.toTarget(repo);
    const snapshot = await adapter.snapshot(target);

    const stack = detectStack(snapshot.samples, snapshot.files);
    await run.log(`stack: ${describeStack(stack) || 'not detected'} · ${snapshot.files.length} files`);

    const topLevelDirs = topDirs(snapshot);
    const entryPoints = findEntryPoints(snapshot);

    // The model drafts the three docs that need judgement. The scaffold's
    // other files are deterministic templates — no reason to spend tokens or
    // risk hallucination on a runbook stub.
    let drafted: DraftedDocs | null = null;
    if (apiKey) {
      await run.log('drafting architecture · conventions · glossary');
      const result = await this.anthropic.call<DraftedDocs>({
        apiKey,
        model,
        maxTokens: 16_000,
        effort: 'high',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({ repo, projectName, stack, snapshot, topLevelDirs, entryPoints }),
        schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
      });
      await run.meter(result.model, result.usage);
      drafted = result.parsed ?? null;
      const unverified = countUnverified(drafted);
      await run.log(
        `drafted ${unverified} UNVERIFIED marker(s) · ${result.usage.outputTokens} output tokens`,
      );
    } else {
      await run.log(
        'no AI credential available — writing template scaffold only (every claim marked UNVERIFIED)',
        'warn',
      );
    }

    const agentsMd = renderAgentsMd({
      repoName: repo.name,
      stack,
      isPrimary: repo.isPrimary,
      projectName,
    });

    const files = renderScaffold({
      repoName: repo.name,
      projectName,
      isPrimary: repo.isPrimary,
      stack,
      topLevelDirs,
      entryPoints,
      glossaryTerms: (drafted?.glossaryTerms ?? []).map((t) => t.term),
      date: new Date().toISOString().slice(0, 10),
      agentsMd,
      architectureMd: drafted ? wrapDoc(`Architecture — ${repo.name}`, drafted.architecture) : undefined,
      conventionsMd: drafted ? wrapDoc(`Conventions — ${repo.name}`, drafted.conventions) : undefined,
      glossaryMd: drafted ? renderGlossaryDoc(repo.name, drafted.glossaryTerms) : undefined,
    });

    const unverifiedCount = files.reduce(
      (acc, f) => acc + (f.content.match(/UNVERIFIED/g)?.length ?? 0),
      0,
    );

    const body = renderSetupPrBody({
      repoName: repo.name,
      projectName,
      fileCount: files.length,
      unverifiedCount,
      stackLine: describeStack(stack) || 'not detected',
    });

    await run.log(`proposing ${files.length} files for review`);
    const change = await adapter.propose(target, {
      branch: 'specd/setup',
      title: `specd setup — knowledge base and agent working agreements`,
      body,
      files,
    });

    await this.db
      .update(repositories)
      .set({
        setupBranch: change.branch,
        setupPrUrl: change.url,
        setupState: 'open',
        stack: stack as unknown as Record<string, unknown>,
      })
      .where(eq(repositories.id, repo.id));

    await run.log(change.reviewHint);
    return { ...change, fileCount: files.length };
  }
}

const SYSTEM_PROMPT = `You are the specd onboarding agent. You draft the first version of a repository's
knowledge base from a read-only scan, for human review.

Your output is a DRAFT that a senior engineer will read critically. Your
credibility — and the product's — depends entirely on one thing: never
presenting inference as fact.

Rules, in priority order:

1. Mark every claim you cannot ground in the evidence you were given with the
   literal token UNVERIFIED, followed by what a human should check. Do this
   inline, where the claim is, not in a footnote. A doc with twenty honest
   UNVERIFIED markers is far more useful than one with five confident
   fabrications.
2. Ground what you CAN ground. File paths, manifests, dependency names, script
   names and directory structure are evidence — state those plainly and do not
   mark them UNVERIFIED.
3. Never invent: module responsibilities you cannot see, data models you were
   not shown, deployment topology, team process, SLAs, or the reasoning behind
   a design. If the file tree suggests something, say it is suggested by the
   tree, and mark it UNVERIFIED.
4. Write for two readers at once: an AI agent that will act on this before
   writing code, and a human who will review the result. Be concrete and terse.
   Prefer a table over a paragraph. No filler, no restating the obvious, no
   "this document describes..." preamble.
5. Do not include an H1 title or a status banner — those are added around your
   text. Start at H2.

For the glossary: mine domain terms that actually appear in the code (module
names, entity names, recurring nouns in identifiers). Give each a one-line
meaning, and where you are guessing say so with UNVERIFIED. Skip generic
programming vocabulary — "service", "controller" and "handler" teach nobody
anything. Return at most 20 terms; return fewer, or none, rather than padding.`;

function buildUserPrompt(input: {
  repo: Repository;
  projectName: string;
  stack: DetectedStack;
  snapshot: RepoSnapshot;
  topLevelDirs: string[];
  entryPoints: string[];
}): string {
  const { repo, projectName, stack, snapshot, topLevelDirs, entryPoints } = input;

  // A representative slice of the tree: enough shape to reason about, not so
  // much that the useful signal drowns.
  const tree = summarizeTree(snapshot.files);

  const manifests = snapshot.samples
    .map((s) => `--- ${s.path} ---\n${s.content.slice(0, 8_000)}`)
    .join('\n\n');

  return `Repository: ${repo.name}${repo.isPrimary ? ' (primary repo of the project)' : ''}
Project: ${projectName}
Detected stack: ${describeStack(stack) || 'not detected'}
Detected verify command: ${stack.verifyCommand ?? 'none detected'}
Top-level directories: ${topLevelDirs.join(', ') || 'none'}
Likely entry points: ${entryPoints.join(', ') || 'none detected'}
Total tracked files: ${snapshot.files.length}

=== FILE TREE (summarized) ===
${tree}

=== MANIFESTS AND README ===
${manifests || '(no manifest files found)'}

Draft the architecture and conventions documents, and mine the glossary.
Remember: this is everything you get. Anything not visible above is UNVERIFIED.`;
}

/** Directory-level summary with file counts — shape without the noise. */
function summarizeTree(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split('/');
    const dir = parts.length === 1 ? '.' : parts.slice(0, Math.min(3, parts.length - 1)).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  const lines = sorted.map(([dir, n]) => `${dir}/  (${n} file${n === 1 ? '' : 's'})`);

  // Plus a sample of actual filenames, which carry naming conventions.
  const sample = files.filter((f) => !f.includes('/')).slice(0, 25);
  if (sample.length) {
    lines.push('', 'root files: ' + sample.join(', '));
  }
  return lines.join('\n');
}

function topDirs(snapshot: RepoSnapshot): string[] {
  const dirs = new Set<string>();
  for (const file of snapshot.files) {
    const [first] = file.split('/');
    if (first && file.includes('/') && !IGNORED_DIRS.has(first)) dirs.add(first);
  }
  return [...dirs].sort().slice(0, 20);
}

function findEntryPoints(snapshot: RepoSnapshot): string[] {
  const candidates = [
    'src/main.ts',
    'src/index.ts',
    'src/main.py',
    'main.go',
    'cmd',
    'src/app.tsx',
    'app/page.tsx',
    'manage.py',
    'src/main.rs',
  ];
  return snapshot.files.filter((f) => candidates.some((c) => f === c || f.startsWith(`${c}/`))).slice(0, 6);
}

function wrapDoc(title: string, body: string): string {
  return `# ${title}

> **status: DRAFT — review before trusting.** Generated by specd from a
> read-only repo scan. Claims the agent could not ground in the code are
> marked \`UNVERIFIED\`. Merging this PR is how you adopt it; edit freely.

${body.trim()}
`;
}

function renderGlossaryDoc(repoName: string, terms: { term: string; meaning: string }[]): string {
  const rows = terms.length
    ? terms.map((t) => `| **${t.term}** | ${t.meaning.replace(/\|/g, '\\|')} |`).join('\n')
    : '| _(no domain terms mined — add yours)_ | |';

  return `# Glossary — ${repoName}

> **status: DRAFT — review before trusting.** Generated by specd from a
> read-only repo scan. Claims the agent could not ground in the code are
> marked \`UNVERIFIED\`. Merging this PR is how you adopt it; edit freely.

Domain terms mined from code and docs. The agent can spot the words; only a
human can confirm what they mean.

| Term | Meaning |
| --- | --- |
${rows}
`;
}

function countUnverified(drafted: DraftedDocs | null): number {
  if (!drafted) return 0;
  const all = [drafted.architecture, drafted.conventions, ...drafted.glossaryTerms.map((t) => t.meaning)];
  return all.reduce((acc, text) => acc + (text.match(/UNVERIFIED/g)?.length ?? 0), 0);
}
