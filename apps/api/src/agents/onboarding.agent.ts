import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { repositories, type Db, type Repository } from '@specd/db';
import {
  collectEvidence,
  detectStack,
  describeStack,
  renderAgentsMd,
  renderScaffold,
  renderSetupPrBody,
  scaffoldDocPaths,
  type DetectedStack,
  type DraftedKnowledge,
  type RepoEvidence,
} from '@specd/templates';
import type { AiMode, ModelId } from '@specd/shared';
import { DB } from '../db/db.module.js';
import { VcsService } from '../vcs/vcs.service.js';
import type { RepoFile, RepoSnapshot, RepoTarget, VcsAdapter } from '../vcs/vcs.types.js';
import { ModelRouter } from './model.router.js';
import type { RunHandle } from '../runs/runs.service.js';
import { STATION_EFFORT, type Effort } from '@specd/shared';

/**
 * What we ask the model for.
 *
 * Not whole documents — *sections*. The templates own every table that can be
 * read out of a file, so the model is never asked to restate evidence it might
 * get subtly wrong, and the reviewer can tell the two apart at a glance. Flat
 * string slots, because the subscription path validates only top-level keys
 * (`parseAgainstSchema`), and a nested shape there fails in ways that cost a
 * whole run to discover.
 */
export type DraftedDocs = DraftedKnowledge;

const SECTION = (description: string) => ({ type: 'string' as const, description });

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    productPurpose: SECTION(
      'Markdown. What this system is for, in 2-3 sentences, in the words the codebase itself uses. No H1/H2 headings.',
    ),
    productUsers: SECTION(
      'Markdown list. The roles — human and machine — that depend on this, and what each needs from it.',
    ),
    productFlows: SECTION(
      'Markdown list. The two or three paths that carry most of the value, each naming the files it passes through.',
    ),
    productNonGoals: SECTION('Markdown list. What this system deliberately does not do.'),
    architectureBoundaries: SECTION(
      'Markdown. Which module may call which, where transactions begin and end, what crosses a network boundary. Cite paths.',
    ),
    architectureFlows: SECTION(
      'Markdown. One representative request or job traced end to end, naming the files it passes through.',
    ),
    conventionsStyle: SECTION(
      'Markdown. The code-style decisions a reviewer would otherwise repeat in every review: naming, layout, error handling, when an abstraction earns its place.',
    ),
    conventionsReview: SECTION(
      'Markdown list. The rejections that would recur in review of this codebase.',
    ),
    testingPolicy: SECTION(
      'Markdown. Which changes require a test and which may not, specific enough that an agent can decide without asking.',
    ),
    dataModelNotes: SECTION(
      'Markdown. Invariants, ownership, what may write each table. Empty string if the repo has no data layer.',
    ),
    integrationNotes: SECTION(
      'Markdown. Where external clients are constructed, retries/timeouts, request path vs background job. Empty string if none.',
    ),
    glossaryTerms: {
      type: 'array',
      description: 'Domain terms mined from the code. At most 20. Fewer is better than padded.',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          meaning: { type: 'string', description: 'One line. Say UNVERIFIED where you are guessing.' },
          seenIn: { type: 'string', description: 'A path from the evidence where the term appears.' },
        },
        required: ['term', 'meaning'],
        additionalProperties: false,
      },
    },
    openQuestions: {
      type: 'array',
      description:
        'What you could not answer and a human must. At most 8, ordered by what costs most to leave unanswered.',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          why: { type: 'string', description: 'One line on what goes wrong if it stays unanswered.' },
          doc: {
            type: 'string',
            description:
              'Which doc the answer belongs in, e.g. "product.md", "architecture.md", "conventions.md".',
          },
        },
        required: ['question', 'why', 'doc'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'productPurpose',
    'productUsers',
    'productFlows',
    'architectureBoundaries',
    'architectureFlows',
    'conventionsStyle',
    'testingPolicy',
    'glossaryTerms',
    'openQuestions',
  ],
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
    private readonly models: ModelRouter,
  ) {}

  /**
   * The DB/network-bound half: read-only clone, stack detection, prompt
   * assembly. Split out from `run()` so a dispatched job can be prepared
   * server-side and handed only a prompt+schema — the same shape as
   * `SpecAgent.prepare()`/`finalize()`, and for the same reason: the
   * clone/propose calls here are VCS REST API calls with a platform-held
   * token, not a real git checkout (`WorkspaceService`, used only by the
   * build station, is the one that needs a runner's own filesystem), so
   * there is nothing about them that benefits from running on a runner —
   * only the model call does.
   */
  async prepare(input: {
    repo: Repository;
    projectName: string;
    run: RunHandle;
  }): Promise<PreparedOnboardCall> {
    const { repo, projectName, run } = input;

    await run.log(`clone (read-only) · ${repo.name}`);
    const adapter = await this.vcs.adapterFor(repo);
    const target = this.vcs.toTarget(repo);
    const snapshot = await adapter.snapshot(target);

    const stack = detectStack(snapshot.samples, snapshot.files);
    const evidence = collectEvidence({ files: snapshot.files, samples: snapshot.samples });

    await run.log(
      `stack: ${describeStack(stack) || 'not detected'} · ` +
        `${snapshot.files.length} files, ${snapshot.samples.length} read`,
    );
    await run.log(`evidence: ${describeEvidence(evidence)}`);

    return {
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ repo, projectName, stack, snapshot, evidence }),
      schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
      ctx: { repo, projectName, stack, evidence },
    };
  }

  /**
   * The other half: turn a drafted (or absent) set of docs into a scaffold,
   * propose it, and record the result. Pure network/DB — no model call, so
   * it runs the same way whether the draft came from the synchronous path
   * or a runner's report.
   */
  async finalize(
    parsed: DraftedDocs | null,
    ctx: PreparedOnboardCall['ctx'],
    log: (message: string, level?: 'info' | 'warn' | 'error') => Promise<void> = async () => undefined,
  ): Promise<{ branch: string; url: string | null; reviewHint: string; fileCount: number }> {
    const { repo, projectName, stack } = ctx;
    const drafted = parsed;

    const adapter = await this.vcs.adapterFor(repo);
    const target = this.vcs.toTarget(repo);

    // A job queued before this shape existed carries no evidence pack. Rescan
    // rather than render a hollow scaffold from a payload we can no longer read.
    let evidence = ctx.evidence;
    if (!evidence) {
      await log('job payload predates the evidence pack — rescanning', 'warn');
      evidence = collectEvidence(await adapter.snapshot(target));
    }

    if (drafted) {
      const unverified = countUnverified(drafted);
      await log(`drafted ${unverified} UNVERIFIED marker(s)`);
    } else {
      await log(
        'no AI credential available — writing the scanned scaffold only; every judgement section ' +
          'carries the question it exists to answer',
        'warn',
      );
    }

    const agentsMd = renderAgentsMd({
      repoName: repo.name,
      stack,
      isPrimary: repo.isPrimary,
      projectName,
      docs: scaffoldDocPaths(evidence),
    });

    // What the repo already tells its agents. Onboarding adds to this; it does
    // not get to replace it. Read at HEAD of the default branch rather than
    // taken from the scan, because a queued job's evidence pack records only
    // which agent docs *exist*, and the merge needs their text.
    const existing = await readAgentDocs(adapter, target);
    if (existing.agentsMd || existing.claudeMd) {
      await log(
        `${[existing.agentsMd && 'AGENTS.md', existing.claudeMd && 'CLAUDE.md']
          .filter(Boolean)
          .join(' + ')} already here — appending under a specd marker, keeping what is there`,
      );
    }

    const files = renderScaffold({
      repoName: repo.name,
      projectName,
      isPrimary: repo.isPrimary,
      stack,
      evidence,
      date: new Date().toISOString().slice(0, 10),
      agentsMd,
      drafted,
      existing,
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
      evidence,
      drafted: Boolean(drafted),
    });

    await log(`proposing ${files.length} files for review`);
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

    await log(change.reviewHint);
    return { ...change, fileCount: files.length };
  }

  async run(input: {
    repo: Repository;
    projectName: string;
    apiKey: string | null;
    model: ModelId;
    mode: AiMode;
    /** Defaults to the ground station's level. */
    effort?: Effort;
    run: RunHandle;
  }): Promise<{ branch: string; url: string | null; reviewHint: string; fileCount: number }> {
    const { repo, projectName, apiKey, model, mode, run } = input;

    const prepared = await this.prepare({ repo, projectName, run });

    // The model drafts the three docs that need judgement. The scaffold's
    // other files are deterministic templates — no reason to spend tokens or
    // risk hallucination on a runbook stub.
    let drafted: DraftedDocs | null = null;
    if (apiKey || mode === 'subscription_runner') {
      await run.log('drafting architecture · conventions · glossary');
      const result = await this.models.call<DraftedDocs>(mode, {
        apiKey: apiKey ?? '',
        model,
        maxTokens: 32_000,
        effort: input.effort ?? STATION_EFFORT.ground,
        system: prepared.system,
        user: prepared.user,
        schema: prepared.schema,
      });
      if (result.model !== model) {
        await run.log(
          `requested ${model} but the provider served ${result.model}`,
          'warn',
        );
      }
      await run.meter(result.model, result.usage, result.billable);
      drafted = result.parsed ?? null;
      await run.log(`${result.usage.outputTokens} output tokens`);
    }

    return this.finalize(drafted, prepared.ctx, (message, level) => run.log(message, level));
  }
}

export interface PreparedOnboardCall {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  ctx: {
    repo: Repository;
    projectName: string;
    stack: DetectedStack;
    /** Optional only because a job may have been queued by an older build. */
    evidence?: RepoEvidence;
  };
}


const SYSTEM_PROMPT = `You are the specd onboarding agent. You write the judgement half of a
repository's knowledge base, for human review.

The other half is already done and you do not repeat it. Tables of commands, CI
steps, services, configuration variables, entity names and directory weights are
rendered directly from the files the scan opened, with their sources named. Your
sections sit between those tables and answer what a file cannot: why the system
is shaped this way, what the words mean, what a reviewer will reject.

Your output is a DRAFT a senior engineer will read critically. Your credibility
— and the product's — depends on one thing: never presenting inference as fact.

Rules, in priority order:

1. Mark every claim you cannot ground in the evidence you were given with the
   literal token UNVERIFIED, followed by what a human should check. Inline,
   where the claim is. A section with two honest UNVERIFIED markers is far more
   useful than one with five confident fabrications.
2. Ground what you CAN ground, and show your ground: name the file. Paths,
   manifests, dependency names, script names, CI steps and directory structure
   are evidence — state those plainly, unmarked. "Every route is registered in
   apps/api/src/app.module.ts" is a fact; "the API is horizontally scalable" is
   not.
3. Never invent: module responsibilities you cannot see, data you were not
   shown, deployment topology, team process, SLAs, or the reasoning behind a
   design. If the tree merely suggests something, say it is suggested by the
   tree and mark it UNVERIFIED.
4. Prefer the specific to the general. "Handlers return DTOs, never entities"
   is worth a page of "the code follows clean architecture". If you have
   nothing specific for a section, return one honest UNVERIFIED line for it
   rather than padding.
5. Write for two readers at once: an agent that will act on this before writing
   code, and a human reviewing the result. Terse, concrete, no preamble, no
   restating the obvious, no "this document describes…". Markdown lists and
   short paragraphs. Do not emit H1 or H2 headings — your text is inserted
   under headings that already exist.

On specific sections:

- productPurpose / productUsers / productFlows: this is what requirements get
  written against. Read the README and entry points for it. If the repo does
  not say what it is for, say so — a guessed purpose is the single most
  expensive thing you can get wrong, because every future spec inherits it.
- architectureBoundaries: the rule an agent would otherwise break. Who may call
  whom, what owns a transaction, what crosses a process or network boundary.
- conventionsStyle / conventionsReview: derive from the code you were shown —
  naming, error handling, file layout, the shape of a typical module.
- glossaryTerms: domain terms that actually appear (entity names, recurring
  nouns in identifiers, words from the README). One line each, and set seenIn
  to a path from the evidence. Skip generic programming vocabulary — "service",
  "controller", "handler" teach nobody anything. At most 20; fewer is better
  than padded.
- openQuestions: what a human must answer before the next spec is trustworthy.
  Order by cost of leaving it unanswered. At most 8. Do not list something the
  evidence already answers.`;

function buildUserPrompt(input: {
  repo: Repository;
  projectName: string;
  stack: DetectedStack;
  snapshot: RepoSnapshot;
  evidence: RepoEvidence;
}): string {
  const { repo, projectName, stack, snapshot, evidence } = input;

  return `Repository: ${repo.name}${repo.isPrimary ? ' (primary repo of the project)' : ''}
Project: ${projectName}
Detected stack: ${describeStack(stack) || 'not detected'}
Detected verify command: ${stack.verifyCommand ?? 'none detected'}
Tracked files: ${snapshot.files.length} (${snapshot.samples.length} read in full)

=== WHAT THE SCAN READ OUT OF THE REPOSITORY ===
These facts are already rendered into the docs, with their sources. Use them to
reason; do not restate them.

${renderEvidenceBlock(evidence)}

=== FILE TREE (summarized) ===
${summarizeTree(snapshot.files)}

=== FILE CONTENTS ===
${renderSamples(snapshot.samples)}

Write the sections. This is everything you get: anything not visible above is
UNVERIFIED, and saying so is the correct answer.`;
}

/** The evidence pack, compact enough to leave room for file contents. */
function renderEvidenceBlock(evidence: RepoEvidence): string {
  const parts: string[] = [];
  const push = (title: string, body: string | null) => {
    if (body) parts.push(`## ${title}\n${body}`);
  };

  push(
    'Modules by weight',
    list(evidence.modules.slice(0, 16).map((m) => `${m.path}/ — ${m.files} files${m.kind ? `, mostly ${m.kind}` : ''}`)),
  );
  push('Entry points', list(evidence.entryPoints));
  push(
    'Workspaces',
    list(evidence.workspaces.map((w) => `${w.path} — ${w.name ?? 'unnamed'}${w.scripts.length ? ` (scripts: ${w.scripts.join(', ')})` : ''}`)),
  );
  push('Declared commands', list(evidence.scripts.slice(0, 24).map((s) => `${s.name} → ${s.command}`)));
  push(
    'CI',
    list(
      evidence.ci.map(
        (c) => `${c.path}${c.triggers.length ? ` (on ${c.triggers.join(', ')})` : ''}: ${c.commands.slice(0, 8).join(' ; ') || 'no commands parsed'}`,
      ),
    ),
  );
  push(
    'Runtime services',
    list(evidence.services.map((s) => `${s.name}${s.image ? ` (${s.image})` : ''}${s.ports.length ? ` ports ${s.ports.join(', ')}` : ''}`)),
  );
  push(
    'Configuration variables',
    list(evidence.envVars.slice(0, 40).map((v) => `${v.name}${v.note ? ` — ${v.note}` : ''}`)),
  );
  push('Data stores', list(evidence.dataStores));
  push('Entities declared', list(evidence.entities.slice(0, 30).map((e) => `${e.name} (${e.source})`)));
  push('Integrations', list(evidence.integrations.map((i) => `${i.name} — ${i.evidence}`)));
  push(
    'Tests',
    evidence.tests.fileCount
      ? `${evidence.tests.fileCount} files · ${evidence.tests.patterns.join(', ') || 'mixed naming'} · ${evidence.tests.frameworks.join(', ') || 'framework not detected'} · in ${evidence.tests.dirs.slice(0, 5).join(', ')}`
      : 'none found',
  );
  push('Existing docs', list(evidence.docs));
  push('Existing agent instructions', list(evidence.existingAgentDocs));

  return parts.join('\n\n') || '(nothing readable found)';
}

function list(items: string[]): string | null {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : null;
}

/**
 * File contents, under a total budget.
 *
 * The scan now opens up to ~50 files; pasting all of them whole would spend
 * the context window on lockfile-shaped noise and push the README — the single
 * most useful file for the product doc — past the point the model still weighs
 * it. So: a per-file cap, a total cap, and README first.
 */
function renderSamples(samples: RepoFile[], totalBudget = 90_000): string {
  const ordered = [...samples].sort((a, b) => rank(a.path) - rank(b.path));

  const chunks: string[] = [];
  let spent = 0;
  let skipped = 0;

  for (const sample of ordered) {
    const remaining = totalBudget - spent;
    if (remaining < 500) {
      skipped += 1;
      continue;
    }
    const body = sample.content.slice(0, Math.min(12_000, remaining));
    chunks.push(`--- ${sample.path} ---\n${body}`);
    spent += body.length;
  }

  if (skipped) chunks.push(`(${skipped} further file(s) omitted for budget)`);
  return chunks.join('\n\n') || '(no readable files found)';
}

/** README first, then manifests, then everything else in scan order. */
function rank(path: string): number {
  if (/^readme\.(md|rst)$/i.test(path)) return 0;
  if (/^(architecture|contributing)\.md$/i.test(path)) return 1;
  if (!path.includes('/')) return 2;
  return 3;
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

/** One line for the run log: what the scan actually came back with. */
function describeEvidence(evidence: RepoEvidence): string {
  return (
    [
      `${evidence.scripts.length} command(s)`,
      `${evidence.ci.length} pipeline(s)`,
      `${evidence.services.length} service(s)`,
      `${evidence.envVars.length} config var(s)`,
      `${evidence.entities.length} entity name(s)`,
      `${evidence.tests.fileCount} test file(s)`,
    ].join(' · ') + (evidence.existingAgentDocs.length ? ` · found ${evidence.existingAgentDocs.join(', ')}` : '')
  );
}

/**
 * The agent instructions a repository already has, at HEAD.
 *
 * Failing to read them must not fail the run: the worst outcome of an empty
 * answer here is the scaffold specd wrote before this existed, whereas a
 * failed grounding run leaves a project with no knowledge base at all.
 */
async function readAgentDocs(
  adapter: VcsAdapter,
  target: RepoTarget,
): Promise<{ agentsMd: string | null; claudeMd: string | null }> {
  const found = await adapter.readFiles(target, ['AGENTS.md', 'CLAUDE.md']).catch(() => []);
  const at = (path: string) => found.find((f) => f.path === path)?.content ?? null;
  return { agentsMd: at('AGENTS.md'), claudeMd: at('CLAUDE.md') };
}

function countUnverified(drafted: DraftedDocs | null): number {
  if (!drafted) return 0;
  const sections = [
    drafted.productPurpose,
    drafted.productUsers,
    drafted.productFlows,
    drafted.productNonGoals,
    drafted.architectureBoundaries,
    drafted.architectureFlows,
    drafted.conventionsStyle,
    drafted.conventionsReview,
    drafted.testingPolicy,
    drafted.dataModelNotes,
    drafted.integrationNotes,
    ...(drafted.glossaryTerms ?? []).map((t) => t.meaning),
  ];
  return sections.reduce((acc, text) => acc + (text?.match(/UNVERIFIED/g)?.length ?? 0), 0);
}
