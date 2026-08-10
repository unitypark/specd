import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderAsBuiltMarkdown, type ModelId, type SpecContent, type TokenUsage } from '@specd/shared';
import { callClaudeCode } from './claude.js';
import {
  canReachRemote,
  changedFiles,
  commitAll,
  commitCount,
  isGitAvailable,
  pushBranch,
  shallowClone,
  startBranch,
} from './git.js';

/**
 * The build station, executed on the runner's own machine.
 *
 * This is the one job kind that does not reduce to "call the model, hand back
 * JSON". Each task's model call edits files the next task's call will read, so
 * the filesystem is the state carried between calls and the whole loop has to
 * live on one machine (`knowledge/decisions/0009-...`).
 *
 * What stays on the server: choosing what to build, rendering the prompts,
 * metering, and opening the pull request. What happens here: clone, edit,
 * commit, verify, file the as-built spec, push — all with the git credentials
 * this machine already has. specd sends no token, and this file never asks
 * for one.
 */

export interface BuildJob {
  model: ModelId;
  system: string;
  branch: string;
  asBuiltPath: string;
  asBuiltCommitMessage: string;
  verifyCommand: string | null;
  tasks: { id: string; title: string; prompt: string; commitMessage: string }[];
  remote: { cloneUrl: string; baseBranch: string };
  ticketKey: string;
  ctx: {
    repo: { name: string };
    spec: {
      ticketKey: string;
      title: string;
      version: number;
      status: string;
      approvedBy?: string | null;
      approvedAt?: string | null;
      content: SpecContent;
    };
  };
}

export interface BuildOutcome {
  report: {
    tasksAttempted: number;
    tasksCommitted: number;
    commits: number;
    verifyPassed: boolean | null;
    verifyOutput: string | null;
  };
  usage: TokenUsage;
  model: ModelId;
}

type Narrate = (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>;

export async function runBuildJob(job: BuildJob, narrate: Narrate): Promise<BuildOutcome> {
  if (!(await isGitAvailable())) {
    throw new Error('`git` was not found on PATH. A build needs a real checkout on this machine.');
  }

  // Ask the credential question first, while it is still cheap to answer.
  const parent = await mkdtemp(join(tmpdir(), 'specd-build-'));
  const reachable = await canReachRemote(job.remote.cloneUrl, parent);
  if (reachable !== true) {
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `This runner cannot reach ${job.remote.cloneUrl} with its own git credentials, so it ` +
        `cannot push the result. Git said: ${reachable}`,
    );
  }

  const dir = join(parent, 'repo');
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let observedModel: ModelId | null = null;

  let tasksAttempted = 0;
  let tasksCommitted = 0;
  let verifyPassed: boolean | null = null;
  let verifyOutput: string | null = null;

  try {
    await narrate(`cloning ${job.ctx.repo.name} at ${job.remote.baseBranch}`);
    await shallowClone(job.remote.cloneUrl, job.remote.baseBranch, dir, parent);
    await startBranch(dir, job.branch);
    await narrate(`workspace ready on ${job.branch}`);

    for (const [index, task] of job.tasks.entries()) {
      tasksAttempted += 1;
      await narrate(`▸ ${task.id} ${task.title} (${index + 1}/${job.tasks.length})`);

      const result = await callClaudeCode({
        model: job.model,
        system: job.system,
        user: task.prompt,
        workspaceDir: dir,
      });

      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cacheReadInputTokens =
        (usage.cacheReadInputTokens ?? 0) + (result.usage.cacheReadInputTokens ?? 0);
      usage.cacheCreationInputTokens =
        (usage.cacheCreationInputTokens ?? 0) + (result.usage.cacheCreationInputTokens ?? 0);
      observedModel ??= result.model;

      const changed = await changedFiles(dir);
      if (changed.length === 0) {
        await narrate(`  ${task.id} produced no changes`, 'warn');
        continue;
      }

      const sha = await commitAll(dir, task.commitMessage);
      if (sha) {
        tasksCommitted += 1;
        await narrate(`  ${task.id} committed ${sha.slice(0, 8)} · ${changed.length} file(s)`);
      }
    }

    // Verify — specd runs this, never the agent. The model was never given a
    // shell, and this string came from the repository's own detected stack.
    if (job.verifyCommand) {
      await narrate(`verifying: ${job.verifyCommand}`);
      const verify = await runShell(job.verifyCommand, dir, 600_000);
      verifyOutput = verify.output.slice(-4_000);

      const couldNotRun = looksUnrunnable(verify.output);
      verifyPassed = verify.code === 0 ? true : couldNotRun ? null : false;

      await narrate(
        verifyPassed === true
          ? '  verify passed ✓'
          : couldNotRun
            ? '  verify could not run here (toolchain or dependencies missing) — not a code failure'
            : `  verify FAILED (exit ${verify.code}) — the branch is left for you to inspect`,
        verifyPassed === true ? 'info' : 'warn',
      );
    } else {
      await narrate('no verify command detected for this repo — skipping verification', 'warn');
    }

    // Rule 7: the as-built spec rides the same branch as the code. Rendered by
    // shared code so this file is byte-identical to the in-process path's.
    const target = join(dir, job.asBuiltPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      renderAsBuiltMarkdown(
        {
          ticketKey: job.ctx.spec.ticketKey,
          title: job.ctx.spec.title,
          version: job.ctx.spec.version,
          status: job.ctx.spec.status as never,
          approvedBy: job.ctx.spec.approvedBy,
          approvedAt: job.ctx.spec.approvedAt,
          content: job.ctx.spec.content,
        },
        { passed: verifyPassed, command: job.verifyCommand },
      ),
      'utf8',
    );
    if (await commitAll(dir, job.asBuiltCommitMessage)) {
      await narrate(`as-built spec filed → ${job.asBuiltPath}`);
    }

    const commits = await commitCount(dir, job.remote.baseBranch);

    // Everything so far lives only in a directory about to be deleted. The
    // push is the point at which this build produced something.
    await narrate(`pushing ${job.branch} as this machine's git user`);
    await pushBranch(dir, job.remote.cloneUrl, job.branch);

    return {
      report: { tasksAttempted, tasksCommitted, commits, verifyPassed, verifyOutput },
      usage,
      model: observedModel ?? job.model,
    };
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Did the verify command fail to *run*, rather than run and report failures?
 * Missing dependencies or an absent binary say nothing about the code. Kept
 * identical to `apps/api/src/agents/build.agent.ts`'s copy.
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
