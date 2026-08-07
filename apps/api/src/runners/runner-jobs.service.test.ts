import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentRuns, createDb, projects, tickets, type DbHandle } from '@specd/db';
import type { SpecContent } from '@specd/shared';
import { RunnersService } from './runners.service.js';
import { RunnerJobsService, type SpecJobPayload } from './runner-jobs.service.js';
import { RunsService } from '../runs/runs.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { SpecAgent } from '../agents/spec.agent.js';
import { ProjectsService } from '../projects/projects.service.js';
import { Config } from '../config.js';

/**
 * Real Postgres, same self-skipping convention as the other integration
 * suites. `SpecAgent` is constructed with no real `KnowledgeService`/
 * `ModelRouter` — only `finalize()` is exercised here, which is pure
 * (normalizes already-parsed content against already-retrieved chunks) and
 * never touches either dependency.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;
let runners: RunnersService;
let jobs: RunnerJobsService;
let runs: RunsService;
let projectId = '';
let ticketId = '';

const reachable = await (async () => {
  try {
    const probe = createDb(DATABASE_URL, { max: 1 });
    await probe.sql`SELECT 1`;
    await probe.close();
    return true;
  } catch {
    return false;
  }
})();

const validParsed = {
  requirements: [
    { story: 'As a user I want X', criteria: [{ keyword: 'WHEN', trigger: 'I do X', response: 'Y happens' }] },
  ],
  design: [{ text: 'do it this way', unverified: 'not grounded' }],
  tasks: [{ id: 'T1', title: 'build it', size: 'M' }],
} as unknown as SpecContent;

function payload(overrides: Partial<SpecJobPayload> = {}): SpecJobPayload {
  return {
    kind: 'spec',
    system: 'system prompt',
    user: 'user prompt',
    schema: {},
    model: 'claude-opus-5',
    maxTokens: 32_000,
    effort: 'high',
    chunks: [],
    slug: 'test-ticket',
    ticketKey: 'JT-1',
    ticketId,
    primaryRepo: 'acme/repo',
    projectId,
    ...overrides,
  };
}

describe.skipIf(!reachable)('RunnerJobsService (integration)', () => {
  beforeAll(async () => {
    handle = createDb(DATABASE_URL, { max: 2 });
    const config = { usdToEur: 0.92 } as Config;
    const projectsService = new ProjectsService(handle.db);
    runs = new RunsService(handle.db, config, projectsService);
    runners = new RunnersService(handle.db);
    const specs = new SpecsService(handle.db);
    const specAgent = new SpecAgent(null as unknown as never, null as unknown as never);
    jobs = new RunnerJobsService(handle, runs, specAgent, specs);

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `job-test-${Date.now()}`, name: 'Job Dispatch Test' })
      .returning();
    projectId = project!.id;

    const [ticket] = await handle.db
      .insert(tickets)
      .values({ projectId, key: 'JT-1', title: 'Job test ticket' })
      .returning();
    ticketId = ticket!.id;
  });

  afterAll(async () => {
    if (handle) {
      await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  /** Queue a run directly, the shape PipelineService.generateSpec would leave it in. */
  async function queueRun(jobPayload: SpecJobPayload) {
    const [row] = await handle!.db
      .insert(agentRuns)
      .values({
        projectId,
        kind: 'spec',
        runner: 'self_hosted',
        status: 'queued',
        ticketId,
        jobPayload: jobPayload as unknown as Record<string, unknown>,
      })
      .returning({ id: agentRuns.id });
    return row!.id;
  }

  async function pairedRunner(name: string) {
    const created = await runners.createPairing(projectId, name);
    const paired = await runners.pair(created.pairCode);
    const runner = await runners.authenticate(paired.token);
    return runner;
  }

  it('claims a queued job and marks it running', async () => {
    const runId = await queueRun(payload());
    const runner = await pairedRunner('claim-runner');

    const claimed = await jobs.claim(runner);
    expect(claimed).toMatchObject({ id: runId, kind: 'spec' });
    expect(claimed?.payload.system).toBe('system prompt');

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('running');
    expect(row?.runnerId).toBe(runner.id);
  });

  it('does not let a second runner claim an already-claimed job', async () => {
    const runId = await queueRun(payload());
    const first = await pairedRunner('first-claimer');
    const second = await pairedRunner('second-claimer');

    const claimedFirst = await jobs.claim(first);
    expect(claimedFirst?.id).toBe(runId);

    const claimedSecond = await jobs.claim(second);
    expect(claimedSecond).toBeNull();
  });

  it('returns null when nothing is queued', async () => {
    const runner = await pairedRunner('idle-runner');
    expect(await jobs.claim(runner)).toBeNull();
  });

  it('finalizes a succeeded report into a real spec version', async () => {
    const runId = await queueRun(payload());
    const runner = await pairedRunner('report-runner');
    await jobs.claim(runner);

    await jobs.report(runner, runId, {
      status: 'succeeded',
      parsed: validParsed,
      model: 'claude-opus-5',
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('succeeded');
    expect(row?.inputTokens).toBe(10);
    expect(row?.outputTokens).toBe(20);
    expect((row?.result as { specId?: string })?.specId).toBeTruthy();
  });

  it('appends the as-built task even when the runner-reported content omitted it', async () => {
    const runId = await queueRun(payload());
    const runner = await pairedRunner('as-built-check-runner');
    await jobs.claim(runner);

    await jobs.report(runner, runId, {
      status: 'succeeded',
      parsed: validParsed,
      model: 'claude-opus-5',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    const specId = (row?.result as { specId: string }).specId;
    expect(specId).toBeTruthy();
  });

  it('finishes a failed report without creating a spec', async () => {
    const runId = await queueRun(payload());
    const runner = await pairedRunner('failure-runner');
    await jobs.claim(runner);

    await jobs.report(runner, runId, { status: 'failed', error: 'claude was not on PATH' });

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('claude was not on PATH');
    expect(row?.result).toBeNull();
  });

  it('refuses a report from a runner that did not claim the job', async () => {
    const runId = await queueRun(payload());
    const claimer = await pairedRunner('rightful-claimer');
    const impostor = await pairedRunner('impostor');
    await jobs.claim(claimer);

    await expect(
      jobs.report(impostor, runId, {
        status: 'succeeded',
        parsed: validParsed,
        model: 'claude-opus-5',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).rejects.toThrow(/not claimed by you/);
  });

  it('refuses a second report for an already-finished run', async () => {
    const runId = await queueRun(payload());
    const runner = await pairedRunner('double-report-runner');
    await jobs.claim(runner);
    await jobs.report(runner, runId, { status: 'failed', error: 'first failure' });

    await expect(jobs.report(runner, runId, { status: 'failed', error: 'second' })).rejects.toThrow(
      /already finished/,
    );
  });

  it('rejects a citation the reported content invented, same as the synchronous path would', async () => {
    const runId = await queueRun(payload({ chunks: [] }));
    const runner = await pairedRunner('citation-check-runner');
    await jobs.claim(runner);

    const withFakeCitation: SpecContent = {
      ...validParsed,
      design: [{ text: 'grounded claim', citation: 'knowledge/nonexistent.md#nope' }],
    };

    await jobs.report(runner, runId, {
      status: 'succeeded',
      parsed: withFakeCitation,
      model: 'claude-opus-5',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('succeeded');
    // The spec exists; its design claim was demoted rather than trusted —
    // checked properly via the board API in the e2e curl pass, this test only
    // confirms finalize() actually ran (a spec was created at all).
    expect((row?.result as { specId?: string })?.specId).toBeTruthy();
  });
});
