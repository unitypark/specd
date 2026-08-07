import type { ModelId, TokenUsage } from '@specd/shared';
import { callClaude, isClaudeAvailable } from './claude.js';

/**
 * The daemon `specd runner pair` promised was coming: this polls the API for
 * queued jobs paired to this machine, drives the local `claude` CLI for each
 * one, and reports the result back. It never touches the database or the
 * knowledge index directly — the server already did that work before queueing
 * (`SpecAgent.prepare`) and does the rest after this reports back
 * (`SpecAgent.finalize`). This daemon only ever sees an opaque prompt+schema
 * request and returns a parsed reply.
 *
 * Scoped to `spec` jobs only (§9 follow-up) — `onboard`/`build` jobs need a
 * git checkout on this machine, which is a separate piece of work.
 */

interface SpecJobPayload {
  kind: 'spec';
  system: string;
  user: string;
  schema: Record<string, unknown>;
  model: ModelId;
  maxTokens: number;
  ticketKey: string;
}

interface ClaimedJob {
  id: string;
  kind: string;
  payload: SpecJobPayload;
}

const API = (process.env.SPECD_API ?? 'http://localhost:4000/api').replace(/\/$/, '');
const TOKEN = process.env.SPECD_RUNNER_TOKEN;
const POLL_INTERVAL_MS = Number(process.env.SPECD_RUNNER_POLL_MS ?? 5_000);

async function main() {
  if (!TOKEN) {
    console.error('SPECD_RUNNER_TOKEN is not set. Pair this machine first with `specd runner pair <code>`,');
    console.error('then export the stored token (see `specd runner token`) before starting this daemon.');
    process.exit(1);
  }

  if (!(await isClaudeAvailable())) {
    console.error('`claude` was not found on PATH. Install the Claude Code CLI and sign in first.');
    process.exit(1);
  }

  const identity = await heartbeat();
  console.log(`specd-runner: paired as "${identity.name}", polling ${API} every ${POLL_INTERVAL_MS}ms`);

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('specd-runner: finishing the current cycle, then exiting…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      await pollOnce();
    } catch (err) {
      console.error('specd-runner: poll cycle failed:', err instanceof Error ? err.message : err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function pollOnce() {
  const job = await claim();
  if (!job) return;

  console.log(`specd-runner: claimed ${job.kind} job ${job.id} (${job.payload.ticketKey})`);

  if (job.kind !== 'spec') {
    await report(job.id, { status: 'failed', error: `This runner cannot execute "${job.kind}" jobs yet.` });
    return;
  }

  try {
    const result = await callClaude({
      model: job.payload.model,
      system: job.payload.system,
      user: job.payload.user,
      schema: job.payload.schema,
      maxTokens: job.payload.maxTokens,
    });
    await report(job.id, {
      status: 'succeeded',
      parsed: result.parsed,
      model: result.model,
      usage: result.usage,
    });
    console.log(`specd-runner: reported ${job.id} succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report(job.id, { status: 'failed', error: message });
    console.error(`specd-runner: job ${job.id} failed: ${message}`);
  }
}

async function claim(): Promise<ClaimedJob | null> {
  const res = await call('/runners/jobs/claim', { method: 'POST' });
  const body = (await res.json()) as { job: ClaimedJob | null };
  return body.job;
}

async function report(
  jobId: string,
  outcome:
    | { status: 'succeeded'; parsed: unknown; model: ModelId; usage: TokenUsage }
    | { status: 'failed'; error: string },
): Promise<void> {
  await call(`/runners/jobs/${jobId}/report`, {
    method: 'POST',
    body: JSON.stringify(outcome),
  });
}

async function heartbeat(): Promise<{ name: string }> {
  const res = await call('/runners/heartbeat', { method: 'POST' });
  return (await res.json()) as { name: string };
}

async function call(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('specd-runner: fatal:', err);
  process.exit(1);
});
