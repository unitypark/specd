import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { Repository } from '@specd/db';
import {
  asBuiltPath,
  renderSpecMarkdown,
  slugify,
  specBranchName,
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

  async run(input: {
    repo: Repository;
    spec: SpecView;
    projectName: string;
    knowledgeExcerpts: string;
    model: ModelId;
    run: RunHandle;
  }): Promise<BuildResult> {
    const { repo, spec, run, model } = input;

    const slug = slugify(spec.title);
    const branch = specBranchName(spec.ticketKey, slug);
    const asBuilt = asBuiltPath(spec.ticketKey, slug);

    await run.log(`spec ${spec.ticketKey} v${spec.version} pulled · ${spec.content.tasks.length} tasks`);
    await run.log(`preparing isolated workspace on ${branch}`);

    const workspace = await this.workspaces.create(repo, branch);
    // `stack` is whatever the onboarding scan detected, persisted as JSON —
    // treat it as untrusted shape rather than asserting it is complete.
    const stack = (repo.stack ?? {}) as Partial<DetectedStack>;

    let tasksAttempted = 0;
    let tasksCommitted = 0;
    let verifyPassed: boolean | null = null;
    let verifyOutput: string | null = null;

    try {
      // The last task files the as-built spec; specd does that itself, so the
      // agent implements everything before it.
      const codeTasks = spec.content.tasks.filter((t) => !isAsBuiltTask(t));

      for (const [index, task] of codeTasks.entries()) {
        tasksAttempted += 1;
        await run.log(`▸ ${task.id} ${task.title} (${index + 1}/${codeTasks.length})`);

        const result = await this.claudeCode.code({
          model,
          workspaceDir: workspace.dir,
          system: BUILD_SYSTEM_PROMPT,
          user: buildTaskPrompt({
            spec,
            task,
            projectName: input.projectName,
            repoName: repo.name,
            knowledgeExcerpts: input.knowledgeExcerpts,
            remaining: codeTasks.slice(index + 1),
          }),
        });

        await run.meter(result.model ?? model, result.usage, false);

        const changed = await this.workspaces.changedFiles(workspace.dir);
        if (changed.length === 0) {
          await run.log(`  ${task.id} produced no changes`, 'warn');
          continue;
        }

        const sha = await this.workspaces.commitAll(
          workspace.dir,
          `${spec.ticketKey} ${task.id}: ${task.title}\n\nPer spec ${spec.ticketKey} v${spec.version}.`,
        );
        if (sha) {
          tasksCommitted += 1;
          await run.log(`  ${task.id} committed ${sha.slice(0, 8)} · ${changed.length} file(s)`);
        }
      }

      // Verify — specd runs this, never the agent.
      const verifyCommand = typeof stack.verifyCommand === 'string' ? stack.verifyCommand : null;
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
      await writeFile(asBuiltTarget, renderAsBuilt(spec, verifyPassed, verifyCommand), 'utf8');
      const asBuiltSha = await this.workspaces.commitAll(
        workspace.dir,
        `${spec.ticketKey}: file as-built spec\n\nCloses the loop — this spec now grounds the next one.`,
      );
      if (asBuiltSha) {
        await run.log(`as-built spec filed → ${asBuilt}`);
      }

      const commits = await this.workspaces.commitCount(workspace.dir, workspace.baseBranch);
      await run.log(
        `branch ${branch} ready · ${commits} commit(s) · review with ` +
          `\`git diff ${workspace.baseBranch}..${branch}\``,
      );

      return {
        branch,
        tasksAttempted,
        tasksCommitted,
        commits,
        verifyPassed,
        verifyOutput,
        asBuiltPath: asBuilt,
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

/** The as-built record. Written by specd so it is exact, not paraphrased. */
function renderAsBuilt(
  spec: SpecView,
  verifyPassed: boolean | null,
  verifyCommand: string | null,
): string {
  const header = [
    `<!-- Filed automatically by specd when ${spec.ticketKey} was built. -->`,
    '<!-- This is a historical record: never rewrite it. If reality later -->',
    '<!-- diverged, append a "## Deviations" section below.              -->',
    '',
  ].join('\n');

  const verification = verifyCommand
    ? `\n## Verification\n\n\`${verifyCommand}\` — ${
        verifyPassed === null ? 'not run' : verifyPassed ? 'passed' : '**failed** at build time'
      }\n`
    : '\n## Verification\n\nNo verify command was detected for this repository.\n';

  return (
    header +
    renderSpecMarkdown({
      ticketKey: spec.ticketKey,
      title: spec.title,
      version: spec.version,
      status: spec.status,
      approvedBy: spec.approvedBy,
      approvedAt: spec.approvedAt,
      content: spec.content,
    }) +
    verification
  );
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
