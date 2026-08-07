import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SchemaMismatch,
  parseAgainstSchema,
  schemaInstruction,
  type ClaudeCodeEnvelope,
  type ModelId,
  type TokenUsage,
} from '@specd/shared';

/**
 * The same `claude --print --output-format json` invocation as
 * `apps/api/src/agents/claude-code.provider.ts`, duplicated rather than
 * shared — this package runs on a different machine than the API and has no
 * NestJS DI container to plug a shared provider into. Any behavioral change
 * here (retry count, disallowed tools) should be mirrored there too.
 */

export interface ClaudeCallOptions {
  model: ModelId;
  system: string;
  user: string;
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface ClaudeCallResult<T = unknown> {
  text: string;
  parsed?: T;
  usage: TokenUsage;
  model: ModelId;
}

export async function isClaudeAvailable(): Promise<boolean> {
  try {
    const { stdout, code } = await exec(['--version'], '', 15_000, process.cwd());
    return code === 0 && /claude code/i.test(stdout);
  } catch {
    return false;
  }
}

export async function callClaude<T = unknown>(opts: ClaudeCallOptions): Promise<ClaudeCallResult<T>> {
  const system = opts.schema ? `${opts.system}\n${schemaInstruction(opts.schema)}` : opts.system;

  const first = await invoke(opts, system, opts.user);

  if (!opts.schema) {
    return { text: first.text, usage: first.usage, model: first.model ?? opts.model };
  }

  try {
    const parsed = parseAgainstSchema<T>(first.text, opts.schema);
    return { text: first.text, parsed, usage: first.usage, model: first.model ?? opts.model };
  } catch (err) {
    const why = err instanceof SchemaMismatch ? err.message : String(err);
    const repair = await invoke(
      opts,
      system,
      `${opts.user}\n\nYour previous reply could not be used: ${why}\n` +
        'Reply again with ONLY the JSON object required by the output contract.',
    );
    const usage = mergeUsage(first.usage, repair.usage);
    const parsed = parseAgainstSchema<T>(repair.text, opts.schema);
    return { text: repair.text, parsed, usage, model: repair.model ?? opts.model };
  }
}

async function invoke(
  opts: ClaudeCallOptions,
  system: string,
  user: string,
): Promise<{ text: string; usage: TokenUsage; model: ModelId | null }> {
  const scratch = await mkdtemp(join(tmpdir(), 'specd-runner-'));
  try {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      opts.model,
      '--system-prompt',
      system,
      '--exclude-dynamic-system-prompt-sections',
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

    const { stdout, stderr, code, timedOut } = await exec(
      args,
      user,
      opts.maxTokens && opts.maxTokens > 16_000 ? 900_000 : 300_000,
      scratch,
    );

    if (timedOut) throw new Error('Claude Code did not respond in time; the job was cancelled.');
    if (code !== 0) {
      throw new Error(`Claude Code exited ${code}: ${(stderr || stdout).slice(0, 400).trim() || 'no output'}`);
    }

    let envelope: ClaudeCodeEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeCodeEnvelope;
    } catch {
      throw new Error(`Could not read Claude Code's JSON envelope: ${stdout.slice(0, 300).trim()}`);
    }
    if (envelope.is_error || envelope.api_error_status) {
      throw new Error(`Claude Code reported an error: ${envelope.api_error_status ?? envelope.subtype ?? 'unknown'}`);
    }

    const modelKey = Object.keys(envelope.modelUsage ?? {})[0];
    const canonical = modelKey ? (envelope.modelUsage?.[modelKey]?.canonicalModel ?? modelKey) : null;

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
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function exec(
  args: string[],
  stdin: string,
  timeoutMs: number,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      env: stripClaudeSessionVars(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
  };
}

function stripClaudeSessionVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (/^CLAUDE(_CODE)?(_|$)/.test(key) || key === 'CLAUDECODE') delete copy[key];
  }
  return copy;
}
