import { resolve } from 'node:path';

/**
 * Walks the whole pipeline over the real HTTP API, exactly as the web app
 * would: Connect → Ground → Spec → human gate → CLI handoff → Learn.
 *
 * Run with:  pnpm --filter @specd/api loop
 *
 * Steps that need a model say so and are reported as SKIPPED rather than
 * quietly passing — a green run that silently skipped the agent would be worse
 * than a red one.
 */

const API = process.env.SPECD_API ?? 'http://localhost:4000/api';
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
/** Set SPECD_AI_MODE=subscription_runner to drive the local Claude Code (D2). */
const AI_MODE = (process.env.SPECD_AI_MODE ?? (HAS_KEY ? 'api_key' : '')) as
  | 'api_key'
  | 'subscription_runner'
  | '';
let aiReady = false;

let token = '';
let passed = 0;
let skipped = 0;

async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { raw?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 600)}`);
  }
  if (opts.raw) return text as T;
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/**
 * Wait for a queued run to reach a terminal state and hand back its result.
 * Polling is right here and nowhere else: this is an external script, not the
 * server, and it has no listen connection to be woken on.
 */
async function awaitRun<T>(slug: string, runId: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await call<{ status: string; result: T; error?: string | null }>(
      'GET',
      `/projects/${slug}/runs/${runId}`,
    );
    if (run.status === 'succeeded') return run.result;
    if (run.status === 'failed') throw new Error(`run ${runId} failed: ${run.error ?? 'no reason given'}`);
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${run.status} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function step(label: string): void {
  passed += 1;
  console.log(`  [32m✓[0m ${label}`);
}

function skip(label: string, why: string): void {
  skipped += 1;
  console.log(`  [33m∅[0m ${label}\n      skipped: ${why}`);
}

function section(n: string, title: string): void {
  console.log(`\n[1m${n} ${title}[0m`);
}

async function main(): Promise<void> {
  const stamp = Date.now();
  console.log(`\nspecd end-to-end loop  ·  ${API}`);
  console.log(`AI mode: ${AI_MODE || 'none configured'}`);
  // ─── 01 CONNECT ───────────────────────────────────────────────────────────
  section('01', 'CONNECT');

  const auth = await call<{ token: string; user: { name: string } }>('POST', '/auth/register', {
    email: `loop-${stamp}@specd.dev`,
    name: 'Loop Runner',
    password: 'correct-horse-battery',
  });
  token = auth.token;
  step(`registered ${auth.user.name}`);

  if (AI_MODE === 'subscription_runner') {
    // Deliberately not wrapped in a catch: a failed preflight must fail the
    // run, not quietly turn every agent step into a skip.
    const modes = await call<Record<string, { ok: boolean; detail: string }>>(
      'GET',
      '/projects/ai-modes',
    );
    aiReady = Boolean(modes.subscription_runner?.ok);
    step(
      aiReady
        ? `subscription mode available — ${modes.subscription_runner?.detail}`
        : `subscription mode unavailable — ${modes.subscription_runner?.detail}`,
    );
  } else {
    aiReady = HAS_KEY;
  }

  const project = await call<{ slug: string; name: string }>('POST', '/projects', {
    name: `Aurora CRM ${stamp}`,
    description: 'Customer CRM — API, web app and infra',
    spendCapCents: 10_000,
  });
  const slug = project.slug;
  step(`created project ${project.name} (${slug})`);

  await call('POST', `/projects/${slug}/connections/vcs`, { provider: 'local' });
  await call('POST', `/projects/${slug}/connections/tracker`, { provider: 'board' });
  step('connected code (local) and tracker (built-in board)');

  if (aiReady) {
    const ai = await call<{ ok: boolean; detail: string }>(
      'POST',
      `/projects/${slug}/connections/ai`,
      AI_MODE === 'subscription_runner'
        ? { mode: 'subscription_runner', model: process.env.SPECD_MODEL ?? 'claude-sonnet-5' }
        : { mode: 'api_key', apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.SPECD_MODEL ?? 'claude-sonnet-5' },
    );
    if (!ai.ok) throw new Error(`AI connection refused: ${ai.detail}`);
    step(`connected AI — ${AI_MODE === 'subscription_runner' ? 'your Claude subscription (local)' : 'API key'}`);
  }

  const fixture = resolve(process.cwd(), '../../.specd-work/fixtures/aurora-api');
  const inspected = await call<{ ok: boolean; clean?: boolean; branch?: string }>(
    'GET',
    `/projects/${slug}/inspect-path?path=${encodeURIComponent(fixture)}`,
  );
  if (!inspected.ok) {
    throw new Error(`Fixture repo missing. Run: pnpm db:seed\n  expected at ${fixture}`);
  }
  step(`inspected ${fixture} — git, ${inspected.clean ? 'clean' : 'dirty'}, on ${inspected.branch}`);

  const repo = await call<{ id: string; name: string; isPrimary: boolean }>(
    'POST',
    `/projects/${slug}/repositories`,
    { provider: 'local', name: 'aurora-api', localPath: fixture, isPrimary: true },
  );
  step(`registered repository ${repo.name}${repo.isPrimary ? ' (primary)' : ''}`);

  // ─── 02 GROUND ────────────────────────────────────────────────────────────
  section('02', 'GROUND');

  const onboarded = await call<
    { repoName: string; branch?: string; reviewHint?: string; fileCount?: number; error?: string; runId: string }[]
  >('POST', `/projects/${slug}/onboard`, { repositoryIds: [repo.id] });

  const result = onboarded[0];
  if (!result) throw new Error('onboarding returned no result');
  if (result.error) throw new Error(`onboarding failed: ${result.error}`);
  step(`onboarding agent wrote ${result.fileCount} files to branch ${result.branch}`);
  if (!aiReady) {
    skip('AI-drafted architecture/conventions/glossary', 'no ANTHROPIC_API_KEY — template scaffold written instead');
  }

  const runDetail = await call<{ logs: { message: string }[] }>(
    'GET',
    `/projects/${slug}/runs/${result.runId}`,
  );
  step(`run log has ${runDetail.logs.length} lines, replayable via SSE`);

  // Merging is adopting. In local mode that is a real git merge by a human;
  // here we do it so the rest of the loop has knowledge to stand on.
  const { simpleGit } = await import('simple-git');
  const git = simpleGit({ baseDir: fixture });
  const startBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  await git.merge([result.branch!, '--no-edit']);
  step(`merged ${result.branch} into ${startBranch} — adoption recorded`);

  await call('POST', `/projects/${slug}/repositories/${repo.id}/setup-merged`);

  // Re-indexing is queued now (0012), so the script waits for the run the way
  // any other client would rather than expecting counts from the POST.
  const queued = await call<{ runId: string }>('POST', `/projects/${slug}/reindex`, {});
  const reindexed = await awaitRun<{ indexed: number; health: number }>(slug, queued.runId);
  step(`indexed ${reindexed.indexed} knowledge docs · health ${Math.round(reindexed.health)}%`);

  const knowledge = await call<{
    docs: { path: string; freshness: { stale: boolean } }[];
    health: { score: number; notes: { text: string }[] };
  }>('GET', `/projects/${slug}/knowledge`);
  step(`knowledge tree: ${knowledge.docs.map((d) => d.path.replace('knowledge/', '')).join(', ')}`);

  // ─── 03 SPEC ──────────────────────────────────────────────────────────────
  section('03', 'SPEC');

  const ticket = await call<{ id: string; key: string; title: string }>(
    'POST',
    `/projects/${slug}/board/tickets`,
    {
      title: 'Export contacts to CSV',
      body:
        'Sales ops wants to pull contact lists into Excel for the quarterly campaign. ' +
        'The filters set in the app should apply. Big lists should not freeze the browser ' +
        'like the old report did.',
    },
  );
  step(`wrote ticket ${ticket.key} — ${ticket.title}`);

  let specId: string | null = null;

  if (aiReady) {
    const drafted = await call<{ spec: { id: string; version: number; citationCount: number; unverifiedCount: number; content: { tasks: { title: string }[] } } }>(
      'POST',
      `/projects/${slug}/board/tickets/${ticket.id}/generate-spec`,
      {},
    );
    specId = drafted.spec.id;
    step(
      `SpecAgent drafted v${drafted.spec.version} · ${drafted.spec.citationCount} citations · ` +
        `${drafted.spec.unverifiedCount} UNVERIFIED · ${drafted.spec.content.tasks.length} tasks`,
    );

    const lastTask = drafted.spec.content.tasks.at(-1);
    if (!lastTask || !/as-built|knowledge\/specs\//i.test(lastTask.title)) {
      throw new Error(`Last task must file the as-built spec, got: ${lastTask?.title}`);
    }
    step(`last task files the as-built spec: "${lastTask.title}"`);
  } else {
    skip('SpecAgent draft', 'no AI configured');
  }

  // ─── 04 THE GATE ──────────────────────────────────────────────────────────
  section('04', 'HUMAN GATE');

  if (specId) {
    // The CLI must refuse to pull a draft — the gate is server-side (D13).
    const pullRes = await fetch(`${API}/cli/projects/${slug}/specs/${ticket.key}/pull`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (pullRes.status !== 409) {
      throw new Error(`Expected 409 pulling an unapproved spec, got ${pullRes.status}`);
    }
    step('`specd spec pull` on a draft → 409, refused server-side');

    await call('POST', `/projects/${slug}/board/specs/${specId}/transition`, { to: 'in_review' });
    const approved = await call<{ status: string; approvedBy: string; approvedAt: string }>(
      'POST',
      `/projects/${slug}/board/specs/${specId}/transition`,
      { to: 'approved' },
    );
    step(`approved by ${approved.approvedBy} at ${approved.approvedAt} — recorded`);

    // Illegal transitions are refused by the state machine, not by convention.
    const illegal = await fetch(`${API}/projects/${slug}/board/specs/${specId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: 'draft' }),
    });
    if (illegal.status !== 400) {
      throw new Error(`Expected 400 on approved→draft, got ${illegal.status}`);
    }
    step('approved → draft refused (400): approval is not reversible in place');
  } else {
    skip('gate enforcement', 'no spec to gate — no AI configured');
  }

  // ─── 05 BUILD HANDOFF ─────────────────────────────────────────────────────
  section('05', 'BUILD HANDOFF');

  if (specId) {
    const markdown = await call<string>(
      'GET',
      `/cli/projects/${slug}/specs/${ticket.key}/pull`,
      undefined,
      { raw: true },
    );
    if (!markdown.includes('THE SYSTEM SHALL')) {
      throw new Error('Pulled spec has no EARS criteria');
    }
    step(`\`specd spec pull ${ticket.key}\` → ${markdown.split('\n').length} lines of markdown`);

    const status = await call<{ buildable: boolean; status: string }>(
      'GET',
      `/cli/projects/${slug}/specs/${ticket.key}/status`,
    );
    step(`\`specd spec status\` → ${status.status}, buildable=${status.buildable}`);
  } else {
    skip('CLI handoff', 'no approved spec — no AI configured');
  }

  // ─── 05b BUILD (hosted runner) ────────────────────────────────────────────
  if (specId && AI_MODE === 'subscription_runner') {
    const started = await call<{ runId: string; branch: string }>(
      'POST',
      `/projects/${slug}/board/specs/${specId}/build`,
      {},
    );
    step(`hosted build started → run ${started.runId.slice(0, 8)}, branch ${started.branch}`);

    // Builds run for minutes; follow the run rather than holding a request open.
    const deadline = Date.now() + 30 * 60_000;
    let finished: { run: { status: string; error: string | null; result: Record<string, unknown> | null } } | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const detail = await call<{ run: { status: string; error: string | null; result: Record<string, unknown> | null } }>(
        'GET',
        `/projects/${slug}/runs/${started.runId}`,
      );
      if (detail.run.status !== 'running' && detail.run.status !== 'queued') {
        finished = detail;
        break;
      }
    }
    if (!finished) throw new Error('build did not finish within 30 minutes');
    if (finished.run.status !== 'succeeded') {
      throw new Error(`build ${finished.run.status}: ${finished.run.error}`);
    }

    const built = finished.run.result as unknown as {
      branch: string;
      tasksAttempted: number;
      tasksCommitted: number;
      commits: number;
      verifyPassed: boolean | null;
      asBuiltPath: string;
    };
    step(
      `build finished · ${built.tasksCommitted}/${built.tasksAttempted} tasks committed · ` +
        `${built.commits} commit(s)` +
        (built.verifyPassed === null ? '' : built.verifyPassed ? ' · verify passed' : ' · verify FAILED'),
    );

    // The as-built spec must be on the branch — that is what closes the loop.
    const { simpleGit: sg } = await import('simple-git');
    const onBranch = await sg({ baseDir: fixture }).raw([
      'show', `${built.branch}:${built.asBuiltPath}`,
    ]).catch(() => '');
    if (!onBranch.includes('THE SYSTEM SHALL')) {
      throw new Error(`as-built spec missing or malformed at ${built.asBuiltPath}`);
    }
    step(`as-built spec on the branch: ${built.asBuiltPath}`);

    // The user's working tree must be untouched by the build.
    const wt = await sg({ baseDir: fixture }).status();
    if (!wt.isClean()) throw new Error('build left the working tree dirty');
    step(`working tree still clean on ${wt.current} — build ran in an isolated worktree`);
  } else if (specId) {
    skip('hosted build', 'needs SPECD_AI_MODE=subscription_runner (drives the local Claude Code)');
  }

  // ─── 06 LEARN ─────────────────────────────────────────────────────────────
  section('06', 'LEARN');

  const runs = await call<{ spend: { display: string }; runs: { kind: string; costCents: number }[] }>(
    'GET',
    `/projects/${slug}/runs`,
  );
  const totalCents = runs.runs.reduce((acc, r) => acc + r.costCents, 0);
  step(`${runs.runs.length} auditable runs · spend ${runs.spend.display} (this loop: €${(totalCents / 100).toFixed(2)})`);

  const summary = await call<{ knowledgeHealth: number; specsInReview: number }>(
    'GET',
    `/projects/${slug}`,
  );
  step(`project dashboard: knowledge health ${summary.knowledgeHealth}%`);

  console.log(`\n[1m${passed} passed, ${skipped} skipped[0m`);
  if (skipped > 0) {
    console.log('\nSet ANTHROPIC_API_KEY, or SPECD_AI_MODE=subscription_runner, and re-run.');
  }
  console.log(`\nFixture repo left at ${fixture} — inspect the merged knowledge/ directory there.\n`);
}

main().catch((err: unknown) => {
  console.error(`\n[31m✗ ${err instanceof Error ? err.message : String(err)}[0m\n`);
  process.exit(1);
});
