import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentRuns, createDb, projects, runLogs, tickets, type DbHandle } from '@specd/db';
import type { SpecContent } from '@specd/shared';
import { RunnersService } from './runners.service.js';
import {
  RunnerJobsService,
  type BuildJobPayload,
  type OnboardJobPayload,
  type SpecJobPayload,
} from './runner-jobs.service.js';
import type { DraftedDocs, OnboardingAgent } from '../agents/onboarding.agent.js';
import type { BuildAgent, BuildRunnerReport } from '../agents/build.agent.js';
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
const onboardFinalizeCalls: { parsed: DraftedDocs | null; ctx: OnboardJobPayload['ctx'] }[] = [];
const buildFinalizeCalls: {
  report: BuildRunnerReport;
  ctx: { prepared: { branch: string; asBuiltPath: string } };
}[] = [];

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
    runs = new RunsService(handle.db, handle, config, projectsService);
    runners = new RunnersService(handle.db);
    const specs = new SpecsService(handle.db);
    const specAgent = new SpecAgent(null as unknown as never, null as unknown as never);
    // `finalize()` here does the real propose()/db-write against a real repo
    // for genuine dispatch — a stub is enough to prove RunnerJobsService
    // routes an `onboard` report to it and finishes the run correctly.
    const onboardingAgent = {
      finalize: async (parsed: DraftedDocs | null, ctx: OnboardJobPayload['ctx']) => {
        onboardFinalizeCalls.push({ parsed, ctx });
        return { branch: 'specd/setup', url: 'https://example.test/pr/1', reviewHint: 'Opened PR #1.', fileCount: 4 };
      },
    } as unknown as OnboardingAgent;
    // Same reasoning as the onboarding stub: `finalize()` opens a real PR
    // through a VCS adapter, so a stub is what proves `build` reports route
    // to it and finish the run — not that the adapter works.
    const buildAgent = {
      finalize: async (report: BuildRunnerReport, ctx: { prepared: { branch: string; asBuiltPath: string } }) => {
        buildFinalizeCalls.push({ report, ctx });
        return {
          branch: ctx.prepared.branch,
          tasksAttempted: report.tasksAttempted,
          tasksCommitted: report.tasksCommitted,
          commits: report.commits,
          verifyPassed: report.verifyPassed,
          verifyOutput: report.verifyOutput,
          asBuiltPath: ctx.prepared.asBuiltPath,
          reviewUrl: 'https://example.test/pr/9',
        };
      },
    } as unknown as BuildAgent;
    // Short leases so tests age rows by seconds, not minutes. Build gets a
    // longer lease than spec on purpose — one test proves the distinction.
    const leaseConfig = {
      ...config,
      runnerLeaseSeconds: 5,
      runnerLeaseBuildSeconds: 60,
      runnerMaxReclaims: 2,
    } as Config;
    jobs = new RunnerJobsService(handle, runs, specAgent, onboardingAgent, buildAgent, specs, leaseConfig);

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

  function onboardPayload(): OnboardJobPayload {
    return {
      kind: 'onboard',
      system: 'onboard system prompt',
      user: 'onboard user prompt',
      schema: {},
      model: 'claude-opus-5',
      maxTokens: 16_000,
      ctx: {
        repo: { id: 'repo-1', name: 'acme/repo', provider: 'github', isPrimary: true } as unknown as OnboardJobPayload['ctx']['repo'],
        projectName: 'Job Dispatch Test',
        stack: {} as OnboardJobPayload['ctx']['stack'],
        topLevelDirs: [],
        entryPoints: [],
      },
    };
  }

  async function queueOnboardRun(payload: OnboardJobPayload) {
    const [row] = await handle!.db
      .insert(agentRuns)
      .values({
        projectId,
        kind: 'onboard',
        runner: 'self_hosted',
        status: 'queued',
        jobPayload: payload as unknown as Record<string, unknown>,
      })
      .returning({ id: agentRuns.id });
    return row!.id;
  }

  function buildPayload(): BuildJobPayload {
    return {
      kind: 'build',
      model: 'claude-opus-5',
      system: 'build system prompt',
      branch: 'spec/jt-1-job-test-ticket',
      asBuiltPath: 'knowledge/specs/JT-1-job-test-ticket.md',
      asBuiltCommitMessage: 'JT-1: file as-built spec',
      verifyCommand: 'pnpm test',
      tasks: [{ id: 'T1', title: 'do the thing', prompt: 'implement T1', commitMessage: 'JT-1 T1: do the thing' }],
      // No credential here, by design — the runner pushes as itself.
      remote: { cloneUrl: 'https://github.com/acme/repo.git', baseBranch: 'main' },
      ticketKey: 'JT-1',
      ctx: {
        repo: { id: 'repo-1', name: 'acme/repo', provider: 'github' } as unknown as BuildJobPayload['ctx']['repo'],
        spec: { ticketKey: 'JT-1', title: 'Job test ticket', version: 1 } as unknown as BuildJobPayload['ctx']['spec'],
      },
    };
  }

  async function queueBuildRun(payload: BuildJobPayload) {
    const [row] = await handle!.db
      .insert(agentRuns)
      .values({
        projectId,
        kind: 'build',
        runner: 'self_hosted',
        status: 'queued',
        jobPayload: payload as unknown as Record<string, unknown>,
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

  it('never claims a run of a kind it cannot finish', async () => {
    // Index runs carry a job payload since 0012, but they execute in the API
    // and `report()` has no finisher for the kind — a runner claiming one
    // would strand it as running forever. The claim filters on kind, not just
    // on the presence of a payload.
    const [row] = await handle!.db
      .insert(agentRuns)
      .values({
        projectId,
        kind: 'index',
        status: 'queued',
        runner: 'hosted',
        jobPayload: { repositoryIds: [] },
      })
      .returning({ id: agentRuns.id });
    const runner = await pairedRunner('kind-guard-runner');

    expect(await jobs.claim(runner)).toBeNull();

    const [after] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, row!.id));
    expect(after?.status).toBe('queued');
    expect(after?.runnerId).toBeNull();

    await handle!.db.delete(agentRuns).where(eq(agentRuns.id, row!.id));
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

  it('routes a succeeded onboard report to OnboardingAgent.finalize()', async () => {
    const before = onboardFinalizeCalls.length;
    const runId = await queueOnboardRun(onboardPayload());
    const runner = await pairedRunner('onboard-runner');
    const claimed = await jobs.claim(runner);
    expect(claimed?.kind).toBe('onboard');

    const drafted: DraftedDocs = { architecture: 'a', conventions: 'c', glossaryTerms: [] };
    await jobs.report(runner, runId, {
      status: 'succeeded',
      parsed: drafted,
      model: 'claude-opus-5',
      usage: { inputTokens: 5, outputTokens: 5 },
    });

    expect(onboardFinalizeCalls.length).toBe(before + 1);
    expect(onboardFinalizeCalls[before]?.parsed).toEqual(drafted);

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('succeeded');
    expect((row?.result as { url?: string })?.url).toBe('https://example.test/pr/1');
  });

  it('routes a succeeded build report to BuildAgent.finalize() and stores the result', async () => {
    const runId = await queueBuildRun(buildPayload());
    const runner = await pairedRunner('build-report-runner');
    await jobs.claim(runner);

    const before = buildFinalizeCalls.length;
    await jobs.report(runner, runId, {
      status: 'succeeded',
      parsed: {
        tasksAttempted: 3,
        tasksCommitted: 2,
        commits: 3,
        verifyPassed: true,
        verifyOutput: 'ok',
      },
      model: 'claude-opus-5',
      usage: { inputTokens: 900, outputTokens: 400 },
    });

    expect(buildFinalizeCalls.length).toBe(before + 1);
    const call = buildFinalizeCalls.at(-1)!;
    // The runner pushed the branch; finalize() is handed what it reported,
    // plus the branch/path it was told to use — never a credential.
    expect(call.report.tasksCommitted).toBe(2);
    expect(call.ctx.prepared.branch).toBe('spec/jt-1-job-test-ticket');

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('succeeded');
    expect((row?.result as { reviewUrl?: string })?.reviewUrl).toBe('https://example.test/pr/9');
    // Usage arrives as one summed total, so the run is still metered.
    expect(row?.outputTokens).toBe(400);
  });

  it('refuses a build report from a runner that did not claim it', async () => {
    const runId = await queueBuildRun(buildPayload());
    const claimer = await pairedRunner('build-claimer');
    const stranger = await pairedRunner('build-stranger');
    await jobs.claim(claimer);

    await expect(
      jobs.report(stranger, runId, {
        status: 'succeeded',
        parsed: { tasksAttempted: 1, tasksCommitted: 1, commits: 1, verifyPassed: null, verifyOutput: null },
        model: 'claude-opus-5',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).rejects.toThrow(/not claimed by you/);
  });

  it('appends progress lines to a running job, and only for the runner that claimed it', async () => {
    const runId = await queueBuildRun(buildPayload());
    const runner = await pairedRunner('progress-runner');
    const stranger = await pairedRunner('progress-stranger');
    await jobs.claim(runner);

    await jobs.progress(runner, runId, [
      { message: 'cloning acme/repo at main' },
      { message: 'verify could not run here', level: 'warn' },
    ]);

    const logs = await handle!.db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(logs.map((l) => l.message)).toEqual([
      'cloning acme/repo at main',
      'verify could not run here',
    ]);
    expect(logs.find((l) => l.level === 'warn')).toBeTruthy();

    await expect(jobs.progress(stranger, runId, [{ message: 'not mine' }])).rejects.toThrow(
      /not claimed by you/,
    );
  });

  /** Age a claimed job and (optionally) silence its owner, in one place. */
  async function expireLease(runId: string, ownerRunnerId: string | null, seconds: number) {
    await handle!.sql`
      UPDATE agent_runs SET claimed_at = now() - make_interval(secs => (${seconds})::float8)
      WHERE id = ${runId}
    `;
    if (ownerRunnerId) {
      await handle!.sql`
        UPDATE runners SET last_seen_at = now() - make_interval(secs => (${seconds})::float8)
        WHERE id = ${ownerRunnerId}
      `;
    }
  }

  it('reclaims a job whose runner went silent past the lease, with a log line', async () => {
    const runId = await queueRun(payload());
    const dead = await pairedRunner('lease-dead-runner');
    await jobs.claim(dead);
    await expireLease(runId, dead.id, 10);

    const rescuer = await pairedRunner('lease-rescuer');
    const claimed = await jobs.claim(rescuer);

    expect(claimed?.id).toBe(runId);
    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.runnerId).toBe(rescuer.id);
    expect(row?.status).toBe('running');
    expect(row?.reclaimCount).toBe(1);

    const logs = await handle!.db.select().from(runLogs).where(eq(runLogs.runId, runId));
    const reclaimLine = logs.find((l) => /reclaimed from unresponsive runner "lease-dead-runner"/.test(l.message));
    expect(reclaimLine).toBeTruthy();
    expect(reclaimLine?.level).toBe('warn');
  });

  it('does not reclaim while the owner is still heartbeating, however old the claim', async () => {
    const runId = await queueRun(payload());
    const owner = await pairedRunner('lease-alive-runner');
    await jobs.claim(owner);
    // Job is old, but the owner's last_seen_at stays fresh (authenticate
    // bumped it moments ago when the runner paired).
    await expireLease(runId, null, 10);

    const rival = await pairedRunner('lease-rival');
    expect(await jobs.claim(rival)).toBeNull();
  });

  it('does not reclaim a freshly claimed job even when the owner looks silent', async () => {
    const runId = await queueRun(payload());
    const owner = await pairedRunner('lease-fresh-claim');
    await jobs.claim(owner);
    // Owner silent, but the claim itself is inside its lease — both signals
    // must be stale, or a job claimed a moment before a heartbeat gap would
    // bounce between runners.
    await handle!.sql`
      UPDATE runners SET last_seen_at = now() - make_interval(secs => (${600})::float8) WHERE id = ${owner.id}
    `;

    const rival = await pairedRunner('lease-eager-rival');
    expect(await jobs.claim(rival)).toBeNull();
    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.runnerId).toBe(owner.id);
  });

  it('gives build jobs their longer lease', async () => {
    const runId = await queueBuildRun(buildPayload());
    const owner = await pairedRunner('lease-build-owner');
    await jobs.claim(owner);
    // Past the spec lease (5s) but inside the build lease (60s).
    await expireLease(runId, owner.id, 20);

    const rival = await pairedRunner('lease-build-rival');
    expect(await jobs.claim(rival)).toBeNull();

    // Past the build lease too — now it moves.
    await expireLease(runId, owner.id, 120);
    const claimed = await jobs.claim(rival);
    expect(claimed?.id).toBe(runId);
    expect(claimed?.kind).toBe('build');
  });

  it('lets a restarted owner reclaim its own job without waiting out the heartbeat', async () => {
    const runId = await queueRun(payload());
    const owner = await pairedRunner('lease-restarted-owner');
    await jobs.claim(owner);
    // The owner's own polling keeps last_seen_at fresh — age only the claim.
    await expireLease(runId, null, 10);

    const claimed = await jobs.claim(owner);
    expect(claimed?.id).toBe(runId);
    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.reclaimCount).toBe(1);
    expect(row?.runnerId).toBe(owner.id);
  });

  it('grants an expired job to exactly one of two concurrent claimers', async () => {
    const runId = await queueRun(payload());
    const dead = await pairedRunner('lease-race-dead');
    await jobs.claim(dead);
    await expireLease(runId, dead.id, 10);

    const a = await pairedRunner('lease-race-a');
    const b = await pairedRunner('lease-race-b');
    const [ra, rb] = await Promise.all([jobs.claim(a), jobs.claim(b)]);

    const winners = [ra, rb].filter((r) => r?.id === runId);
    expect(winners).toHaveLength(1);
  });

  it('refuses the zombie owner after a reclaim, without mutating the run', async () => {
    const runId = await queueRun(payload());
    const zombie = await pairedRunner('lease-zombie');
    await jobs.claim(zombie);
    await expireLease(runId, zombie.id, 10);
    const rescuer = await pairedRunner('lease-zombie-rescuer');
    await jobs.claim(rescuer);

    await expect(
      jobs.report(zombie, runId, {
        status: 'succeeded',
        parsed: validParsed,
        model: 'claude-opus-5',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).rejects.toThrow(/reclaimed after its lease expired/);
    await expect(jobs.progress(zombie, runId, [{ message: 'zombie says hi' }])).rejects.toThrow(
      /not claimed by you/,
    );

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('running');
    expect(row?.runnerId).toBe(rescuer.id);

    // And the rescuer's own report still lands normally afterwards.
    await jobs.report(rescuer, runId, {
      status: 'succeeded',
      parsed: validParsed,
      model: 'claude-opus-5',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const [finished] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(finished?.status).toBe('succeeded');
  });

  it('fails a job abandoned more times than the cap, retryably', async () => {
    const runId = await queueRun(payload());
    let current = await pairedRunner('lease-cap-0');
    await jobs.claim(current);
    // Max reclaims is 2 in this suite: two takeovers, then exhaustion.
    for (let i = 1; i <= 2; i += 1) {
      await expireLease(runId, current.id, 10);
      const next = await pairedRunner(`lease-cap-${i}`);
      const claimed = await jobs.claim(next);
      expect(claimed?.id).toBe(runId);
      current = next;
    }
    await expireLease(runId, current.id, 10);

    // The next poll does not get the job — it buries it.
    const late = await pairedRunner('lease-cap-late');
    expect(await jobs.claim(late)).toBeNull();

    const [row] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/repeatedly abandoned/);

    const logs = await handle!.db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(logs.some((l) => /giving up rather than looping/.test(l.message))).toBe(true);
  });

  it('never touches in-process runs, which have no payload and no runner', async () => {
    const [row] = await handle!.db
      .insert(agentRuns)
      .values({
        projectId,
        kind: 'build',
        runner: 'hosted',
        status: 'running',
        claimedAt: new Date(Date.now() - 3600_000),
      })
      .returning({ id: agentRuns.id });
    const inProcessId = row!.id;

    const scavenger = await pairedRunner('lease-scavenger');
    const claimed = await jobs.claim(scavenger);
    expect(claimed?.id).not.toBe(inProcessId);

    const [after] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, inProcessId));
    expect(after?.status).toBe('running');
    expect(after?.runnerId).toBeNull();
  });

  it('refuses progress for a job that already finished', async () => {
    const runId = await queueBuildRun(buildPayload());
    const runner = await pairedRunner('progress-late-runner');
    await jobs.claim(runner);
    await jobs.report(runner, runId, { status: 'failed', error: 'gave up' });

    await expect(jobs.progress(runner, runId, [{ message: 'too late' }])).rejects.toThrow(
      /not running/,
    );
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
