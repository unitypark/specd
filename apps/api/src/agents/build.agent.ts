import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { Repository } from '@specd/db';
import {
  asBuiltPath,
  renderAsBuiltMarkdown,
  slugify,
  specBranchName,
  type CitationDrift,
  type ModelId,
  type SpecTask,
  type SpecView,
} from '@specd/shared';
import type { DetectedStack } from '@specd/templates';
import { ClaudeCodeProvider } from './claude-code.provider.js';
import { WorkspaceService } from '../vcs/workspace.js';
import type { RunHandle } from '../runs/runs.service.js';

export interface BuildResult {
  branch: string;
  tasksAttempted: number;
  tasksCommitted: number;
  commits: number;
  verifyPassed: boolean | null;
  verifyOutput: string | null;
  asBuiltPath: string;
  /** Where to review it. A PR on hosted providers; null in local mode. */
  reviewUrl: string | null;
}

/** One task, with its prompt already rendered so a runner needs no spec knowledge. */
export interface PreparedBuildTask {
  id: string;
  title: string;
  prompt: string;
  commitMessage: string;
}

/**
 * Everything needed to execute a build, wherever it executes.
 *
 * `run()` consumes this in-process; `PipelineService` ships it to a paired
 * runner as a job payload. Both come from the same `prepare()` call, so the
 * two paths cannot drift in what they ask the model for.
 */
export interface PreparedBuild {
  system: string;
  model: ModelId;
  branch: string;
  asBuiltPath: string;
  asBuiltCommitMessage: string;
  verifyCommand: string | null;
  /** Citations that no longer stand where they did at approval (advisory). */
  drifted?: CitationDrift[];
  tasks: PreparedBuildTask[];
  /** Null for `local` repositories, which only ever build on the API host. */
  remote: { cloneUrl: string; baseBranch: string } | null;
}

/**
 * What a runner reports after executing a build on its own machine.
 *
 * Token usage rides the existing `JobReport.usage` field as one summed total
 * rather than appearing here per task: metering only ever accumulates onto the
 * run row, so the sum produces an identical cost, and per-task detail is
 * already visible in the progress log the runner streams as it goes.
 */
export interface BuildRunnerReport {
  tasksAttempted: number;
  tasksCommitted: number;
  commits: number;
  verifyPassed: boolean | null;
  verifyOutput: string | null;
}

/**
 * Station 05 — Build.
 *
 * Implements an approved spec task by task, in an isolated worktree, and
 * leaves a branch for human review. The working agreements it must honour are
 * the ones the setup PR installed (AGENTS.md rules 5–7):
 *
 *   - work only from an approved spec
 *   - implement tasks in order, branch named spec/<id>-<slug>
 *   - the final task files the as-built spec to knowledge/specs/
 *
 * Two deliberate constraints:
 *
 *   1. The agent gets *editing* tools only. specd runs the repo's verify
 *      command itself, so nothing the model emits becomes a shell command.
 *   2. The as-built spec is written by specd, not by the model. It is a
 *      verbatim record of what was approved; asking a model to reproduce it
 *      would invite drift in the one document that is supposed to be exact.
 */
@Injectable()
export class BuildAgent {
  constructor(
    private readonly claudeCode: ClaudeCodeProvider,
    private readonly workspaces: WorkspaceService,
  ) {}

  /**
   * Everything a build needs, resolved before anything executes.
   *
   * Deliberately produces no side effects: it reads the spec and the repo's
   * detected stack and renders strings. That is what makes it safe to call on
   * the dispatch path, where the result travels to another machine rather
   * than being executed here.
   */
  async prepare(input: {
    repo: Repository;
    spec: SpecView;
    projectName: string;
    knowledgeExcerpts: string;
    model: ModelId;
    drifted?: CitationDrift[];
  }): Promise<PreparedBuild> {
    const { repo, spec, model } = input;

    const slug = slugify(spec.title);
    const branch = specBranchName(spec.ticketKey, slug);
    const asBuilt = asBuiltPath(spec.ticketKey, slug);

    // `stack` is whatever the onboarding scan detected, persisted as JSON —
    // treat it as untrusted shape rather than asserting it is complete.
    const stack = (repo.stack ?? {}) as Partial<DetectedStack>;

    // The last task files the as-built spec; specd does that itself, so the
    // agent implements everything before it.
    const codeTasks = spec.content.tasks.filter((t) => !isAsBuiltTask(t));

    return {
      system: BUILD_SYSTEM_PROMPT,
      model,
      branch,
      asBuiltPath: asBuilt,
      drifted: input.drifted ?? [],
      asBuiltCommitMessage: `${spec.ticketKey}: file as-built spec\n\nCloses the loop — this spec now grounds the next one.`,
      verifyCommand: typeof stack.verifyCommand === 'string' ? stack.verifyCommand : null,
      remote: await this.workspaces.remoteFor(repo),
      tasks: codeTasks.map((task, index) => ({
        id: task.id,
        title: task.title,
        prompt: buildTaskPrompt({
          spec,
          task,
          projectName: input.projectName,
          repoName: repo.name,
          knowledgeExcerpts: input.knowledgeExcerpts,
          remaining: codeTasks.slice(index + 1),
        }),
        commitMessage: `${spec.ticketKey} ${task.id}: ${task.title}\n\nPer spec ${spec.ticketKey} v${spec.version}.`,
      })),
    };
  }

  /**
   * Turn a runner's report into the same `BuildResult` the in-process path
   * returns. The runner already pushed the branch with its own credentials
   * (`knowledge/decisions/0009-...`), so the only thing left is the review
   * surface — a VCS API call, which stays here with the platform token.
   */
  async finalize(
    report: BuildRunnerReport,
    ctx: {
      repo: Repository;
      spec: SpecView;
      prepared: Pick<PreparedBuild, 'branch' | 'asBuiltPath' | 'verifyCommand' | 'remote'>;
    },
  ): Promise<BuildResult> {
    const { repo, spec, prepared } = ctx;

    const published = await this.workspaces.openReview(repo, {
      branch: prepared.branch,
      base: prepared.remote?.baseBranch ?? repo.defaultBranch,
      title: `${spec.ticketKey}: ${spec.title}`,
      body: buildPrBody(spec, {
        commits: report.commits,
        verifyPassed: report.verifyPassed,
        verifyCommand: prepared.verifyCommand,
        asBuilt: prepared.asBuiltPath,
      }),
    });

    return {
      branch: prepared.branch,
      tasksAttempted: report.tasksAttempted,
      tasksCommitted: report.tasksCommitted,
      commits: report.commits,
      verifyPassed: report.verifyPassed,
      verifyOutput: report.verifyOutput,
      asBuiltPath: prepared.asBuiltPath,
      reviewUrl: published.url,
    };
  }

  async run(input: {
    repo: Repository;
    spec: SpecView;
    projectName: string;
    knowledgeExcerpts: string;
    model: ModelId;
    run: RunHandle;
  }): Promise<BuildResult> {
    const { repo, spec, run, model } = input;

    const plan = await this.prepare(input);
    const { branch, asBuiltPath: asBuilt } = plan;

    await run.log(`spec ${spec.ticketKey} v${spec.version} pulled · ${spec.content.tasks.length} tasks`);
    await run.log(`preparing isolated workspace on ${branch}`);

    const workspace = await this.workspaces.create(repo, branch);

    let tasksAttempted = 0;
    let tasksCommitted = 0;
    let verifyPassed: boolean | null = null;
    let verifyOutput: string | null = null;

    try {
      for (const [index, task] of plan.tasks.entries()) {
        tasksAttempted += 1;
        await run.log(`▸ ${task.id} ${task.title} (${index + 1}/${plan.tasks.length})`);

        const result = await this.claudeCode.code({
          model,
          workspaceDir: workspace.dir,
          system: plan.system,
          user: task.prompt,
        });

        await run.meter(result.model ?? model, result.usage, false);

        const changed = await this.workspaces.changedFiles(workspace.dir);
        if (changed.length === 0) {
          await run.log(`  ${task.id} produced no changes`, 'warn');
          continue;
        }

        const sha = await this.workspaces.commitAll(workspace.dir, task.commitMessage);
        if (sha) {
          tasksCommitted += 1;
          await run.log(`  ${task.id} committed ${sha.slice(0, 8)} · ${changed.length} file(s)`);
        }
      }

      // Verify — specd runs this, never the agent.
      const verifyCommand = plan.verifyCommand;
      if (verifyCommand) {
        await run.log(`verifying: ${verifyCommand}`);
        const verify = await runShell(verifyCommand, workspace.dir, 600_000);
        verifyOutput = verify.output.slice(-4_000);

        // "Your tests failed" and "I could not run your tests" are different
        // signals to a reviewer. Conflating them would have this branch look
        // broken when the toolchain simply was not installed.
        const couldNotRun = looksUnrunnable(verify.output);
        verifyPassed = verify.code === 0 ? true : couldNotRun ? null : false;

        await run.log(
          verifyPassed === true
            ? '  verify passed ✓'
            : couldNotRun
              ? '  verify could not run here (toolchain or dependencies missing) — not a code failure'
              : `  verify FAILED (exit ${verify.code}) — the branch is left for you to inspect`,
          verifyPassed === true ? 'info' : 'warn',
        );
      } else {
        await run.log('no verify command detected for this repo — skipping verification', 'warn');
      }

      // Rule 7: the as-built spec rides the same branch as the code.
      const asBuiltTarget = join(workspace.dir, asBuilt);
      await mkdir(dirname(asBuiltTarget), { recursive: true });
      await writeFile(
        asBuiltTarget,
        renderAsBuiltMarkdown(spec, { passed: verifyPassed, command: verifyCommand }),
        'utf8',
      );
      const asBuiltSha = await this.workspaces.commitAll(workspace.dir, plan.asBuiltCommitMessage);
      if (asBuiltSha) {
        await run.log(`as-built spec filed → ${asBuilt}`);
      }

      const commits = await this.workspaces.commitCount(workspace.dir, workspace.baseBranch);

      // Hand the branch to wherever this team reviews. On a hosted provider the
      // workspace is a temporary clone about to be deleted, so a branch that is
      // never pushed is a build that produced nothing.
      const published = await workspace.publish({
        title: `${spec.ticketKey}: ${spec.title}`,
        body: buildPrBody(spec, {
        commits,
        verifyPassed,
        verifyCommand,
        asBuilt,
        drifted: plan.drifted ?? [],
      }),
      });

      await run.log(`branch ${branch} ready · ${commits} commit(s) · ${published.reviewHint}`);

      return {
        branch,
        tasksAttempted,
        tasksCommitted,
        commits,
        verifyPassed,
        verifyOutput,
        asBuiltPath: asBuilt,
        reviewUrl: published.url,
      };
    } finally {
      // The worktree goes; the branch it produced stays.
      await workspace.dispose();
    }
  }
}

/**
 * Did the verify command fail to *run*, rather than run and report failures?
 * Missing dependencies or an absent binary say nothing about the code.
 */
export function looksUnrunnable(output: string): boolean {
  return [
    /command not found/i,
    /node_modules missing/i,
    /: not found\b/,
    /cannot find module/i,
    /no such file or directory/i,
    /ENOENT/,
    /is not recognized as an internal or external command/i,
  ].some((pattern) => pattern.test(output));
}

function isAsBuiltTask(task: SpecTask): boolean {
  return Boolean(task.asBuilt) || /as-built|knowledge\/specs\//i.test(task.title);
}

const BUILD_SYSTEM_PROMPT = `You are specd's build agent, implementing one task of an approved spec.

You are working in a throwaway worktree. You have file editing tools and
nothing else — no shell. Do not ask for a shell; specd runs the project's
verify command itself after you finish.

Rules:

1. Implement EXACTLY the one task you are given. Not the next one, not a
   refactor you noticed on the way. Other tasks have their own turns.
2. Read before you write. The knowledge base excerpts below describe this
   codebase's architecture and conventions — follow them rather than importing
   habits from elsewhere. Match the surrounding code's style, naming and
   structure.
3. If the spec's design cites a knowledge doc, that citation is the decision.
   Do not quietly choose a different approach.
4. Where the spec is marked UNVERIFIED, it means nobody confirmed that detail.
   Implement the most reasonable reading, keep it small and easy to change,
   and say what you assumed in your final message.
5. Do not write the as-built spec file — specd files that itself.
6. Do not add tests unless the task asks for them, and do not delete existing
   ones.

Finish with two or three sentences: what you changed, and anything a reviewer
should look at. No preamble, no restating the task.`;

function buildTaskPrompt(input: {
  spec: SpecView;
  task: SpecTask;
  projectName: string;
  repoName: string;
  knowledgeExcerpts: string;
  remaining: SpecTask[];
}): string {
  const { spec, task } = input;

  const criteria = spec.content.requirements
    .flatMap((r) => r.criteria)
    .map((c) => `- ${c.keyword} ${c.trigger} THE SYSTEM SHALL ${c.response}`)
    .join('\n');

  const design = spec.content.design
    .map((d) =>
      d.citation
        ? `- ${d.text}  [per ${d.citation}]`
        : `- ${d.text}  [UNVERIFIED — ${d.unverified ?? 'unconfirmed'}]`,
    )
    .join('\n');

  return `Project: ${input.projectName}   Repository: ${input.repoName}
Spec: ${spec.ticketKey} v${spec.version} — ${spec.title}
Approved by ${spec.approvedBy ?? 'unknown'}${spec.approvedAt ? ` on ${spec.approvedAt}` : ''}

=== KNOWLEDGE BASE (read this first) ===
${input.knowledgeExcerpts || '(nothing indexed for this project yet)'}

=== ACCEPTANCE CRITERIA (the whole spec must satisfy these) ===
${criteria}

=== DESIGN (decided; follow it) ===
${design}

=== YOUR TASK — implement only this one ===
${task.id}: ${task.title}   (size ${task.size}${task.repo ? `, repo ${task.repo}` : ''})

${
  input.remaining.length
    ? `Later tasks, for context only — do NOT do them now:\n${input.remaining
        .map((t) => `  ${t.id}: ${t.title}`)
        .join('\n')}`
    : 'This is the final implementation task.'
}

Implement it in the current directory.`;
}

/** Runs the repo's own verify command. Never a model-supplied string. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      resolve({ code: null, output: `${output}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) resolve({ code: null, output: `${output}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ code, output });
    });
  });
}

/**
 * The PR description a reviewer actually reads first.
 *
 * It leads with what was approved and by whom, because that is the question a
 * reviewer has about agent-written code: not "is this clever" but "is this
 * what we agreed to". Verify status is stated plainly, including the case
 * where it could not run — a reviewer told "passed" when nothing ran has been
 * misled.
 */
export function buildPrBody(
  spec: SpecView,
  meta: {
    commits: number;
    verifyPassed: boolean | null;
    verifyCommand: string | null;
    asBuilt: string;
    drifted?: CitationDrift[];
  },
): string {
  const verify =
    meta.verifyCommand === null
      ? 'No verify command is configured for this repository — nothing was run.'
      : meta.verifyPassed === true
        ? `\`${meta.verifyCommand}\` passed.`
        : meta.verifyPassed === false
          ? `\`${meta.verifyCommand}\` **failed**. The branch is here for you to inspect.`
          : `\`${meta.verifyCommand}\` could not run in the build environment ` +
            '(toolchain or dependencies missing). This is not a passing verify.';

  const approval = spec.approvedBy
    ? `Approved by **${spec.approvedBy}**${spec.approvedAt ? ` on ${new Date(spec.approvedAt).toISOString().slice(0, 10)}` : ''}.`
    : 'No approval is recorded for this spec.';

  // Named where the reviewer is, not only in a run log they would have to go
  // and find. The spec was approved against evidence; if that evidence moved
  // in between, the person merging this is the last one who can notice.
  const drift = (meta.drifted ?? []).length
    ? [
        '',
        `> **${meta.drifted!.length} citation(s) no longer stand where they did at approval.**`,
        '> The spec was approved against evidence that has since changed. This did not',
        '> block the build — it is here so it reaches a human before the merge does.',
        '',
        ...meta.drifted!.map(
          (d) => `> - \`${d.citation}\` — was \`${d.was}\`, now \`${d.now}\`${d.note ? `: ${d.note}` : ''}`,
        ),
      ]
    : [];

  return [
    `Built from **${spec.ticketKey} v${spec.version}** — ${spec.title}`,
    '',
    approval,
    '',
    `- ${meta.commits} commit(s), one per task`,
    `- As-built spec filed at \`${meta.asBuilt}\``,
    `- ${verify}`,
    ...drift,
    '',
    '---',
    '',
    '### Acceptance criteria',
    '',
    ...spec.content.requirements.flatMap((req) =>
      req.criteria.map((c) => `- [ ] ${c.keyword} ${c.trigger} THE SYSTEM SHALL ${c.response}`),
    ),
    '',
    '---',
    '',
    'Merging adopts this: the as-built spec becomes part of the knowledge base and grounds ' +
      'the next spec. Closing without merging rejects it and changes nothing.',
  ].join('\n');
}
