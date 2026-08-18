import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  SchemaMismatch,
  parseAgainstSchema,
  schemaInstruction,
  type ClaudeCodeEnvelope,
  type ModelId,
  type TokenUsage,
  STATION_EFFORT,
  type Effort,
} from '@specd/shared';

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
import { AiNotConfigured } from '../common/errors.js';
import type { ModelCallOptions, ModelCallResult } from './anthropic.service.js';

/**
 * Subscription mode (D2) — drives the *local* Claude Code with the user's own
 * auth, on the user's own machine.
 *
 * This is the only sanctioned way specd supports a Claude subscription. The
 * platform never sees, stores or proxies a subscription credential; it shells
 * out to a CLI that is already logged in. Hosted specd therefore cannot offer
 * this mode at all — which is the honest architecture, not a limitation to
 * work around.
 *
 * Two things it does NOT inherit from the Messages API, both handled here:
 *
 *   1. No schema enforcement. `output_config.format` guarantees shape; a CLI
 *      does not. The schema goes in the prompt, the reply is shape-checked,
 *      and one repair attempt is made before giving up.
 *   2. No per-call billing. Runs consume subscription quota, not euros, so
 *      cost is recorded as zero rather than inventing an API list price the
 *      user was never charged.
 */
@Injectable()
export class ClaudeCodeProvider {
  private readonly logger = new Logger(ClaudeCodeProvider.name);
  private available: boolean | null = null;

  /** Is a usable `claude` binary on PATH? Cached after the first check. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const { stdout, code } = await this.exec(['--version'], '', 15_000, process.cwd());
      this.available = code === 0 && /claude code/i.test(stdout);
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async version(): Promise<string | null> {
    try {
      const { stdout, code } = await this.exec(['--version'], '', 15_000, process.cwd());
      return code === 0 ? stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async call<T = unknown>(opts: ModelCallOptions): Promise<ModelCallResult<T>> {
    if (!(await this.isAvailable())) {
      throw new AiNotConfigured(
        'Subscription mode needs the Claude Code CLI on this machine, and `claude` is not on ' +
          'PATH. Install it and sign in, or switch this project to an API key in Settings → AI.',
      );
    }

    const system = opts.schema
      ? `${opts.system}\n${schemaInstruction(opts.schema)}`
      : opts.system;

    const first = await this.invoke(opts, system, opts.user);

    if (!opts.schema) {
      return {
        text: first.text,
        usage: first.usage,
        model: first.model ?? opts.model,
        stopReason: first.stopReason,
      };
    }

    try {
      const parsed = parseAgainstSchema<T>(first.text, opts.schema);
      return {
        text: first.text,
        parsed,
        usage: first.usage,
        model: first.model ?? opts.model,
        stopReason: first.stopReason,
      };
    } catch (err) {
      // One repair attempt. Beyond that we fail rather than hand a reviewer a
      // spec with a section quietly missing.
      const why = err instanceof SchemaMismatch ? err.message : String(err);
      this.logger.warn(`claude-code reply did not match schema (${why}); retrying once`);

      const repair = await this.invoke(
        opts,
        system,
        `${opts.user}\n\nYour previous reply could not be used: ${why}\n` +
          'Reply again with ONLY the JSON object required by the output contract.',
      );

      const usage = mergeUsage(first.usage, repair.usage);
      const parsed = parseAgainstSchema<T>(repair.text, opts.schema);
      return {
        text: repair.text,
        parsed,
        usage,
        model: repair.model ?? opts.model,
        stopReason: repair.stopReason,
      };
    }
  }

  /**
   * A coding run: the agent may edit files inside `workspaceDir` and nothing
   * else. Deliberately narrower than what Claude Code can do —
   *
   *   - Bash is NOT granted. specd runs the verify command itself, so there is
   *     no path from a model's output to an arbitrary shell command.
   *   - `acceptEdits` lets file writes through without prompting, which is
   *     required for a non-interactive run and is bounded by the tool list.
   *   - cwd is the throwaway worktree, so the user's checkout is untouchable.
   */
  async code(input: {
    model: ModelId;
    system: string;
    user: string;
    workspaceDir: string;
    /** Defaults to the build station's level — the highest of any station. */
    effort?: Effort;
    timeoutMs?: number;
  }): Promise<{ text: string; usage: TokenUsage; model: ModelId | null }> {
    if (!(await this.isAvailable())) {
      throw new AiNotConfigured(
        'Hosted builds drive the Claude Code CLI, and `claude` is not on PATH on this machine.',
      );
    }

    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      input.model,
      // The CLI takes the same five levels the API does. Omitting it left
      // subscription-mode builds running at whatever the CLI defaulted to,
      // regardless of what specd had decided for the station.
      '--effort',
      input.effort ?? STATION_EFFORT.build,
      '--append-system-prompt',
      input.system,
      '--permission-mode',
      'acceptEdits',
      // Editing tools only. No Bash, no network, no task spawning.
      '--allowedTools',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      '--disallowed-tools',
      'Bash',
      'WebFetch',
      'WebSearch',
      'Task',
      'NotebookEdit',
    ];

    const { stdout, stderr, code, timedOut } = await this.exec(
      args,
      input.user,
      input.timeoutMs ?? 900_000,
      input.workspaceDir,
    );

    if (timedOut) throw new Error('The build agent did not finish in time; the run was cancelled.');
    if (code !== 0) {
      throw new Error(
        `Claude Code exited ${code}: ${(stderr || stdout).slice(0, 400).trim() || 'no output'}`,
      );
    }

    let envelope: ClaudeCodeEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeCodeEnvelope;
    } catch {
      throw new Error(`Could not read Claude Code's JSON envelope: ${stdout.slice(0, 300).trim()}`);
    }
    if (envelope.is_error || envelope.api_error_status) {
      throw new Error(
        `Claude Code reported an error: ${envelope.api_error_status ?? envelope.subtype ?? 'unknown'}`,
      );
    }

    const modelKey = Object.keys(envelope.modelUsage ?? {})[0];
    const canonical = modelKey
      ? (envelope.modelUsage?.[modelKey]?.canonicalModel ?? modelKey)
      : null;

    return {
      text: envelope.result ?? '',
      usage: {
        inputTokens: envelope.usage?.input_tokens ?? 0,
        outputTokens: envelope.usage?.output_tokens ?? 0,
        cacheReadInputTokens: envelope.usage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
      },
      model: (canonical as ModelId | null) ?? null,
    };
  }

  /**
   * A read-only pass over a workspace, answering in a schema.
   *
   * Between `call()` (no tools — a text transform) and `code()` (editing tools
   * — it changes the repository), because a reviewer needs the third thing:
   * it must open files the diff only alludes to, and it must not be able to
   * "fix" what it finds. `Write` and `Edit` are denied rather than merely
   * unused, so an over-helpful pass cannot quietly amend the branch it was
   * asked to assess.
   */
  async review<T>(input: {
    model: ModelId;
    effort?: Effort;
    system: string;
    user: string;
    schema: Record<string, unknown>;
    workspaceDir: string;
    timeoutMs?: number;
  }): Promise<{ parsed: T | null; usage: TokenUsage; model: ModelId | null }> {
    if (!(await this.isAvailable())) {
      throw new AiNotConfigured(
        'Reviewing a build drives the Claude Code CLI, and `claude` is not on PATH on this machine.',
      );
    }

    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      input.model,
      '--effort',
      input.effort ?? STATION_EFFORT.review,
      '--append-system-prompt',
      `${input.system}\n${schemaInstruction(input.schema)}`,
      '--permission-mode',
      'plan',
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      '--disallowed-tools',
      'Write',
      'Edit',
      'Bash',
      'WebFetch',
      'WebSearch',
      'Task',
      'NotebookEdit',
    ];

    const { stdout, stderr, code, timedOut } = await this.exec(
      args,
      input.user,
      input.timeoutMs ?? 600_000,
      input.workspaceDir,
    );

    // Every failure here is soft. The branch is built and verified; a review
    // that could not run is a missing opinion, not a broken build.
    if (timedOut || code !== 0) {
      this.logger.warn(
        `review pass did not complete: ${timedOut ? 'timed out' : `exit ${code}`} ${(stderr || '').slice(0, 200)}`,
      );
      return { parsed: null, usage: EMPTY_USAGE, model: null };
    }

    let envelope: ClaudeCodeEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeCodeEnvelope;
    } catch {
      this.logger.warn('review pass returned no readable envelope');
      return { parsed: null, usage: EMPTY_USAGE, model: null };
    }

    const usage: TokenUsage = {
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
      cacheReadInputTokens: envelope.usage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
    };

    try {
      return { parsed: parseAgainstSchema<T>(envelope.result ?? '', input.schema), usage, model: null };
    } catch {
      this.logger.warn('review pass did not answer in the requested shape');
      return { parsed: null, usage, model: null };
    }
  }

  private async invoke(
    opts: ModelCallOptions,
    system: string,
    user: string,
  ): Promise<{
    text: string;
    usage: TokenUsage;
    model: ModelId | null;
    stopReason: string | null;
  }> {
    // Run in a scratch directory, never the user's repository: Claude Code
    // otherwise picks up the project's own CLAUDE.md and file context, which
    // would silently change the prompt out from under us.
    const scratch = await mkdtemp(join(tmpdir(), 'specd-run-'));

    try {
      const args = [
        '--print',
        '--output-format',
        'json',
        '--model',
        opts.model,
        '--effort',
        opts.effort ?? STATION_EFFORT.spec,
        '--system-prompt',
        system,
        // Drop the environment/cwd preamble — this is a text transform.
        '--exclude-dynamic-system-prompt-sections',
        // Spec drafting needs no tools. Denying them keeps the run to a single
        // turn and removes any path to the filesystem or network.
        '--disallowed-tools',
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebFetch',
        'WebSearch',
        'Task',
        'NotebookEdit',
      ];

      const { stdout, stderr, code, timedOut } = await this.exec(
        args,
        user,
        opts.maxTokens && opts.maxTokens > 16_000 ? 900_000 : 300_000,
        scratch,
      );

      if (timedOut) {
        throw new Error('Claude Code did not respond in time; the run was cancelled.');
      }
      if (code !== 0) {
        throw new Error(
          `Claude Code exited ${code}: ${(stderr || stdout).slice(0, 400).trim() || 'no output'}`,
        );
      }

      let envelope: ClaudeCodeEnvelope;
      try {
        envelope = JSON.parse(stdout) as ClaudeCodeEnvelope;
      } catch {
        throw new Error(
          `Could not read Claude Code's JSON envelope: ${stdout.slice(0, 300).trim()}`,
        );
      }

      if (envelope.is_error || envelope.api_error_status) {
        throw new Error(
          `Claude Code reported an error: ${envelope.api_error_status ?? envelope.subtype ?? 'unknown'}`,
        );
      }

      const modelKey = Object.keys(envelope.modelUsage ?? {})[0];
      const canonical = modelKey
        ? (envelope.modelUsage?.[modelKey]?.canonicalModel ?? modelKey)
        : null;

      return {
        text: envelope.result ?? '',
        usage: {
          inputTokens: envelope.usage?.input_tokens ?? 0,
          outputTokens: envelope.usage?.output_tokens ?? 0,
          cacheReadInputTokens: envelope.usage?.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
        },
        model: (canonical as ModelId | null) ?? null,
        stopReason: envelope.stop_reason ?? null,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private exec(
    args: string[],
    stdin: string,
    timeoutMs: number,
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, {
        cwd,
        // Inherit the environment so the CLI finds its own credentials, but
        // strip the markers that tell it it is nested inside another session.
        env: stripClaudeSessionVars(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let exitCode: number | null = null;
      let settled = false;

      // `close` fires once the child has exited AND its stdio streams have
      // ended — but a killed process can still leave a pipe open if a
      // grandchild inherited the write end, in which case `close` never
      // fires at all. Once we've actually sent a kill signal, stop trusting
      // it to arrive and fall back to resolving on a bounded backstop
      // instead, so a hung child can never hang this promise forever.
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(giveUpTimer);
        resolve({ stdout, stderr, code: exitCode, timedOut });
      };

      let giveUpTimer: NodeJS.Timeout;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000);
        giveUpTimer = setTimeout(settle, 15_000);
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(giveUpTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      // `exit` fires as soon as the process itself terminates, ahead of
      // `close` — recording the code here means the backstop still reports a
      // real exit code even if `close` is what never arrives.
      child.on('exit', (code) => {
        exitCode = code;
      });
      child.on('close', (code) => {
        exitCode = code;
        settle();
      });

      // Large prompts go over stdin — argv would hit the platform limit once a
      // spec carries a dozen knowledge excerpts.
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
  };
}

/**
 * A nested run should behave like a fresh one. These variables are set when
 * the API happens to be started from inside a Claude Code session and would
 * otherwise leak that context into the child.
 */
function stripClaudeSessionVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (/^CLAUDE(_CODE)?(_|$)/.test(key) || key === 'CLAUDECODE') delete copy[key];
  }
  return copy;
}
