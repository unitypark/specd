import { type DetectedStack, describeStack } from './stack.js';
import { mergeAgentsMd, mergeClaudeMd, renderAgentsSupplement } from './agents-md.js';
import {
  hasDataEvidence,
  hasIntegrationEvidence,
  type RepoEvidence,
} from './evidence.js';

/**
 * The knowledge/ scaffold.
 *
 * Two kinds of content live in these files and they are never mixed:
 *
 *   **Read** — tables built from files the scan actually opened, each naming
 *   its source. Not marked UNVERIFIED, because it is not a claim; it is a
 *   quotation.
 *
 *   **Drafted** — the judgement calls a scan cannot make: why the boundaries
 *   are where they are, what the domain words mean, what a reviewer will
 *   reject. Every one of these is a model's inference, and where it cannot
 *   ground the inference it says UNVERIFIED and names what to check (§6).
 *
 * The first version of this file was almost entirely the second kind with
 * nothing to draft from, which is why it produced a knowledge base whose
 * every section said UNVERIFIED. Credibility with senior engineers is won or
 * lost in these files, and an honest empty page still loses.
 *
 * One trap worth knowing before editing: knowledge docs are link-extracted
 * (S-102), and a backticked path ending in `.md` becomes a graph edge that
 * must resolve. Paths to files *outside* knowledge/ are therefore rendered
 * without backticks — see `plainDoc()`.
 */

export const DRAFT_BANNER = `> **status: DRAFT — review before trusting.** Tables in this file were read
> out of the files they name. Everything else is a model's inference from a
> read-only scan; where it could not ground a claim it says \`UNVERIFIED\` and
> names what to check. Merging this PR is how you adopt it; edit freely.`;

export interface ScaffoldFile {
  path: string;
  content: string;
}

/**
 * What the onboarding model contributes. Flat, single-purpose markdown slots
 * rather than whole documents: the templates own the structure and the
 * evidence, the model owns the judgement that goes in the gaps. Every field is
 * optional — with no AI credential the scaffold still ships, with the drafted
 * sections replaced by the question that section exists to answer.
 */
export interface DraftedKnowledge {
  productPurpose?: string;
  productUsers?: string;
  productFlows?: string;
  productNonGoals?: string;
  architectureBoundaries?: string;
  architectureFlows?: string;
  conventionsStyle?: string;
  conventionsReview?: string;
  testingPolicy?: string;
  dataModelNotes?: string;
  integrationNotes?: string;
  glossaryTerms?: { term: string; meaning: string; seenIn?: string }[];
  openQuestions?: { question: string; why?: string; doc?: string }[];
}

interface DocContext {
  repoName: string;
  projectName: string;
  stack: DetectedStack;
  evidence: RepoEvidence;
  drafted?: DraftedKnowledge | null;
  /**
   * The reference docs this scaffold is emitting. Carried into every renderer
   * because the optional ones are conditional: a doc that links to
   * `data-model.md` in a repo that never earned one ships a broken edge, and
   * the graph reports it as a health warning against docs the user never wrote.
   */
  docs: string[];
}

// ---------------------------------------------------------------------------
// README — the map
// ---------------------------------------------------------------------------

export function renderKnowledgeReadme(input: DocContext): string {
  const { repoName, projectName, stack, evidence, docs } = input;

  const READING_ORDER: [string, string][] = [
    ['product.md', 'writing requirements — what this system is for and who it serves'],
    ['architecture.md', 'any change that crosses a module boundary'],
    ['conventions.md', 'writing code — commands, style, what a reviewer will reject'],
    ['testing.md', 'calling a task done'],
    ['data-model.md', 'touching stored state'],
    ['integrations.md', 'touching anything outside this repo'],
    ['glossary.md', 'using a domain word in a spec'],
    ['open-questions.md', 'assuming an answer nobody has written down'],
  ];

  const rows = READING_ORDER.filter(([doc]) => docs.includes(`knowledge/${doc}`))
    .map(([doc, when], i) => `| ${i + 1} | [${doc}](${doc}) | ${when} |`)
    .join('\n');

  return `# knowledge/ — start here

${DRAFT_BANNER}

The curated context for **${repoName}** (project: ${projectName}). Agents read
this before they write code; humans read it before they review. Git is the
source of truth — specd holds only a derived index of what is here.

## Read in this order

| # | Doc | Before you… |
| --- | --- | --- |
${rows}

## Specs

[specs/](specs/README.md) is the as-built record: every delivered spec lands
there, and the next spec retrieves it. [specs/TEMPLATE.md](specs/TEMPLATE.md)
is the shape a spec takes here.

## Decisions

[decisions/](decisions/README.md) holds the choices someone already made, with
the context that made them right. Start with
[0001 — adopt spec-driven delivery](decisions/0001-adopt-spec-driven.md).

## Runbooks

- [runbooks/local-dev.md](runbooks/local-dev.md) — first run, restarts, resets
- [runbooks/deploy.md](runbooks/deploy.md) — pipelines, environments, rolling back

## How a change moves through here

1. A ticket becomes a **spec** drafted *from these docs* — requirements, design
   with citations, ordered tasks.
2. A named human approves it. No agent approves its own input.
3. An agent implements the tasks in order, one task per PR, citing the docs it
   relied on ([conventions.md](conventions.md)).
4. The last task files the as-built spec into [specs/](specs/README.md), and the
   index refreshes. The next spec starts from a better base.

## Keeping it true

- **Docs ride the change.** Update them in the same PR as the code, never after.
- A claim nobody can check is worse than a gap nobody filled. Mark it
  \`UNVERIFIED\` and move it to [open-questions.md](open-questions.md).
- specd re-indexes on merge and flags docs whose code has moved underneath them.

**Scanned:** ${evidence.fileCount} files · ${describeStack(stack) || 'stack not detected — please fill in'}
`;
}

// ---------------------------------------------------------------------------
// product.md — the doc that makes a requirement writable
// ---------------------------------------------------------------------------

export function renderProduct(input: DocContext): string {
  const { repoName, evidence, drafted } = input;

  const surfaces = evidence.entryPoints.length
    ? evidence.entryPoints.map((e) => `- \`${e}\``).join('\n')
    : '- UNVERIFIED — no entry point matched the scan; name the way this is started.';

  return `# Product — ${repoName}

${DRAFT_BANNER}

Requirements get written against this file. An agent that knows the file tree
but not what the system is *for* writes plausible features nobody asked for.

## What it does

${draftedOr(drafted?.productPurpose, 'state the job this system does, in two or three sentences, in the words your team uses.')}

## Who uses it

${draftedOr(drafted?.productUsers, 'name the roles — human and machine — that depend on this, and what each needs from it.')}

## Core flows

${draftedOr(drafted?.productFlows, 'list the two or three paths that carry most of the value. A spec that breaks one of these is a spec that needs extra review.')}

## Not this

${draftedOr(drafted?.productNonGoals, 'what this system deliberately does not do. Non-goals stop more bad specs than requirements do.')}

## Where it is entered

${surfaces}

Terms used above should be defined once, in [glossary.md](glossary.md). How the
system is put together is [architecture.md](architecture.md).
`;
}

// ---------------------------------------------------------------------------
// architecture.md
// ---------------------------------------------------------------------------

export function renderArchitecture(input: DocContext): string {
  const { repoName, stack, evidence, drafted } = input;

  const moduleRows = evidence.modules.length
    ? evidence.modules
        .slice(0, 16)
        .map((m) => `| \`${m.path}/\` | ${m.files} | ${m.kind ?? '—'} |`)
        .join('\n')
    : '| _(no directories detected)_ | | |';

  const workspaceSection = evidence.workspaces.length
    ? `## Workspaces

| Path | Package | Own scripts |
| --- | --- | --- |
${evidence.workspaces
  .map(
    (w) =>
      `| \`${w.path}/\` | ${w.name ? `\`${w.name}\`` : '—'} | ${w.scripts.length ? w.scripts.map((s) => `\`${s}\``).join(', ') : '—'} |`,
  )
  .join('\n')}

`
    : '';

  const serviceSection = evidence.services.length
    ? `## Runtime dependencies

Declared in ${plainDoc(evidence.services[0]!.source)} — these must be up before the app is.

| Service | Image | Ports |
| --- | --- | --- |
${evidence.services.map((s) => `| ${s.name} | ${s.image ? `\`${s.image}\`` : '—'} | ${s.ports.join(', ') || '—'} |`).join('\n')}

Starting them is [runbooks/local-dev.md](runbooks/local-dev.md).

`
    : '';

  const languageLine = evidence.languages.length
    ? evidence.languages.map((l) => `${l.language} (${l.files})`).join(' · ')
    : '_none detected_';

  return `# Architecture — ${repoName}

${DRAFT_BANNER}

## Shape

| | |
| --- | --- |
| Stack | ${describeStack(stack) || '_not detected_'} |
| Languages by file count | ${languageLine} |
| Entry points | ${evidence.entryPoints.length ? evidence.entryPoints.map((e) => `\`${e}\``).join(', ') : '_UNVERIFIED — none detected_'} |
| Tracked files | ${evidence.fileCount} |

## Map

Directories by weight — what the repository is mostly made of.

| Path | Files | Mostly |
| --- | --- | --- |
${moduleRows}

${workspaceSection}${serviceSection}## Boundaries

Which module may call which, where a transaction begins and ends, and what
crosses a network boundary. The section agents lean on hardest.

${draftedOr(drafted?.architectureBoundaries, 'the scan sees the tree, not the intent behind it. Describe the call rules and who owns what.')}

## How a request moves

${draftedOr(drafted?.architectureFlows, 'trace one representative request or job end to end, naming the files it passes through.')}

Rules about *how* code inside a boundary is written belong in
[conventions.md](conventions.md).${
    input.docs.includes('knowledge/data-model.md')
      ? ' What is stored, and who owns it, belongs in\n[data-model.md](data-model.md).'
      : ''
  }
`;
}

// ---------------------------------------------------------------------------
// conventions.md
// ---------------------------------------------------------------------------

export function renderConventions(input: DocContext): string {
  const { repoName, stack, evidence, drafted } = input;

  const verify = verifyCommand(stack, evidence);

  const commandRows = evidence.scripts.length
    ? evidence.scripts
        .slice(0, 24)
        .map((s) => `| \`${s.name}\` | ${inlineCode(s.command)} | ${plainDoc(s.source)} |`)
        .join('\n')
    : '| _(no scripts declared)_ | | |';

  const ciSection = evidence.ci.length
    ? `## What CI runs

If it fails here it fails in review. Read out of ${evidence.ci.map((c) => plainDoc(c.path)).join(', ')}.

${evidence.ci
  .map((c) => {
    const head = `**${c.name ?? c.path}**${c.triggers.length ? ` — on ${c.triggers.join(', ')}` : ''}`;
    const body = c.commands.length
      ? c.commands.slice(0, 10).map((cmd) => `- \`${cmd}\``).join('\n')
      : '- UNVERIFIED — no commands parsed out of this pipeline.';
    return `${head}\n\n${body}`;
  })
  .join('\n\n')}

`
    : `## What CI runs

UNVERIFIED — no CI configuration was found in the scan. If a change is verified
somewhere other than a developer's machine, say where; if it is not, say that
too, because it changes how much a reviewer has to do by hand.

`;

  return `# Conventions — ${repoName}

${DRAFT_BANNER}

## Verify before opening a PR

\`\`\`
${verify}
\`\`\`

${ciSection}## Commands

| Command | Runs | Declared in |
| --- | --- | --- |
${commandRows}

## Tooling

| Thing | Value |
| --- | --- |
| Language | ${stack.language} |
| Framework | ${stack.framework ?? '_none detected_'} |
| Package manager | ${stack.packageManager ?? '_none detected_'} |
| Test runner | ${stack.testRunner ?? (evidence.tests.frameworks.join(', ') || '_none detected_')} |
| Linter | ${stack.linter ?? '_none detected_'} |

## Code style

${draftedOr(drafted?.conventionsStyle, 'the scan reads config files, not taste. Record the decisions a reviewer would otherwise repeat in every review: naming, file layout, error handling, when an abstraction earns its place.')}

## What a reviewer will send back

${draftedOr(drafted?.conventionsReview, 'the rejections that recur. An agent that knows these writes a PR that passes first time.')}

## Git

- Spec work branches as \`spec/<ID>-<slug>\`, with a PR titled \`[<ID>] - <Title>\`.
  The id is spelled the way the board spells it, in both.
- One task, one PR. The last task of a spec files the as-built copy into
  [specs/](specs/README.md).
- Docs ride the change: knowledge updates land in the same PR as the code.
- UNVERIFIED — commit message style, review count, merge strategy.

Testing rules live in [testing.md](testing.md).
`;
}

// ---------------------------------------------------------------------------
// testing.md
// ---------------------------------------------------------------------------

export function renderTesting(input: DocContext): string {
  const { repoName, stack, evidence, drafted } = input;
  const { tests } = evidence;

  const layout = tests.fileCount
    ? `| | |
| --- | --- |
| Test files found | ${tests.fileCount} |
| Naming | ${tests.patterns.map((p) => `\`${p}\``).join(', ') || '_mixed_'} |
| Frameworks | ${tests.frameworks.join(', ') || '_UNVERIFIED — none detected_'} |
| Where they live | ${tests.dirs.slice(0, 6).map((d) => `\`${d}/\``).join(', ') || '_alongside the code_'} |`
    : `UNVERIFIED — the scan found no test files. If this project is tested
somewhere else, say where. If it is not tested, say that plainly: an agent that
assumes a safety net exists writes changes as though one does.`;

  const runLine =
    evidence.scripts.find((s) => /\b(test|spec)$/.test(s.name))?.name ??
    stack.verifyCommand ??
    'UNVERIFIED — the command that runs the suite';

  return `# Testing — ${repoName}

${DRAFT_BANNER}

## Run them

\`\`\`
${runLine}
\`\`\`

## Layout

${layout}

## What must have a test

${draftedOr(drafted?.testingPolicy, 'which changes require a test and which may not. Be specific enough that an agent can decide without asking — "new endpoint", "bug fix", "refactor with no behaviour change".')}

## Definition of done

A task is done when the change, its tests and the knowledge docs it affects are
in the same PR, and the verify command in [conventions.md](conventions.md)
passes locally.

- UNVERIFIED — coverage expectations, if any.
- UNVERIFIED — how to run a single test or a subset while iterating.
`;
}

// ---------------------------------------------------------------------------
// data-model.md — emitted only when there is something to say
// ---------------------------------------------------------------------------

export function renderDataModel(input: DocContext): string {
  const { repoName, evidence, drafted } = input;

  const entityRows = evidence.entities.length
    ? evidence.entities
        .slice(0, 30)
        .map((e) => `| \`${e.name}\` | ${plainDoc(e.source)} | UNVERIFIED — what it means, who writes it |`)
        .join('\n')
    : '| _(none parsed)_ | | |';

  return `# Data model — ${repoName}

${DRAFT_BANNER}

## Where state lives

${evidence.dataStores.length ? evidence.dataStores.map((s) => `- ${s}`).join('\n') : '- UNVERIFIED — no store detected.'}

## Entities

Names as they are declared. The meaning column is the part only a human can
fill, and it is what a spec will actually retrieve.

| Entity | Declared in | Meaning |
| --- | --- | --- |
${entityRows}

## Migrations

${
  evidence.migrationDirs.length
    ? `${evidence.migrationDirs.map((d) => `- \`${d}/\``).join('\n')}

- UNVERIFIED — how a migration is generated, reviewed and rolled back.`
    : 'UNVERIFIED — no migration directory found. Say how schema changes are applied.'
}

## Rules that outlive the code

${draftedOr(drafted?.dataModelNotes, 'invariants, ownership, what is allowed to write each table, and the one constraint a newcomer breaks first.')}

Names used here should match [glossary.md](glossary.md).
`;
}

// ---------------------------------------------------------------------------
// integrations.md — emitted only when the repo talks to something
// ---------------------------------------------------------------------------

export function renderIntegrations(input: DocContext): string {
  const { repoName, evidence, drafted } = input;

  const rows = evidence.integrations
    .map((i) => `| ${i.name} | ${i.evidence} | UNVERIFIED — what breaks when it is down |`)
    .join('\n');

  const configRows = evidence.envVars
    .filter((v) => /_(URL|KEY|TOKEN|SECRET|ID|HOST|PORT)$/.test(v.name))
    .slice(0, 30)
    .map((v) => `| \`${v.name}\` | ${cell(v.note)} |`)
    .join('\n');

  return `# Integrations — ${repoName}

${DRAFT_BANNER}

Everything this repo depends on that it does not contain. A spec that touches a
row in this table needs a failure story before it is approved.

| Service | Evidence | On failure |
| --- | --- | --- |
${rows || '| _(none detected)_ | | |'}

${
  configRows
    ? `## Configuration

Read out of ${plainDoc(evidence.envVars[0]?.source ?? '.env.example')}.

| Variable | Note |
| --- | --- |
${configRows}

`
    : ''
}## How they are called

${draftedOr(drafted?.integrationNotes, 'where each client is constructed, what retries and timeouts are set, and which calls are in a request path versus a background job.')}

Local substitutes and credentials for development belong in
[runbooks/local-dev.md](runbooks/local-dev.md).
`;
}

// ---------------------------------------------------------------------------
// glossary.md
// ---------------------------------------------------------------------------

export function renderGlossary(input: DocContext): string {
  const { repoName, drafted, evidence } = input;

  const terms = drafted?.glossaryTerms ?? [];
  const rows = terms.length
    ? terms
        .map(
          (t) =>
            `| **${t.term}** | ${escapePipes(t.meaning)} | ${t.seenIn ? plainDoc(t.seenIn) : '—'} |`,
        )
        .join('\n')
    : entityFallbackRows(evidence);

  return `# Glossary — ${repoName}

${DRAFT_BANNER}

The words this team uses, defined once. A spec that uses a word this file does
not define is a spec two people will read differently.

| Term | Meaning | Seen in |
| --- | --- | --- |
${rows}

Generic programming vocabulary is deliberately absent — "service" and "handler"
teach nobody anything. Add a term the first time a spec has to explain it.
`;
}

function entityFallbackRows(evidence: RepoEvidence): string {
  if (evidence.entities.length) {
    return evidence.entities
      .slice(0, 20)
      .map((e) => `| **${e.name}** | UNVERIFIED — define in one sentence | ${plainDoc(e.source)} |`)
      .join('\n');
  }
  return '| _(no terms mined — add yours)_ | | |';
}

// ---------------------------------------------------------------------------
// open-questions.md — the work list, ordered
// ---------------------------------------------------------------------------

export function renderOpenQuestions(input: DocContext): string {
  const { repoName, stack, evidence, drafted, docs } = input;
  const items: { question: string; why: string; doc: string }[] = [];

  const has = (doc: string) => docs.includes(`knowledge/${doc}`);

  if (!drafted?.productPurpose) {
    items.push({
      question: 'What is this system for, in your own words?',
      why: 'Requirements are drafted against it. Nothing else in here matters as much.',
      doc: 'product.md',
    });
  }
  if (!drafted?.architectureBoundaries) {
    items.push({
      question: 'Which module may call which, and where does a transaction end?',
      why: 'The scan sees the tree, never the rule behind it.',
      doc: 'architecture.md',
    });
  }
  if (!evidence.ci.length) {
    items.push({
      question: 'How is a change verified before it merges?',
      why: 'No CI configuration was found, so nothing tells an agent what "green" means.',
      doc: 'conventions.md',
    });
  }
  if (!verifyDetected(stack, evidence)) {
    items.push({
      question: 'What single command must pass before a PR?',
      why: 'specd runs it before proposing anything. Without it, every build is unverified.',
      doc: 'conventions.md',
    });
  }
  if (!evidence.tests.fileCount && has('testing.md')) {
    items.push({
      question: 'Is this tested, and where?',
      why: 'No test files matched the scan. An agent will assume a safety net that may not exist.',
      doc: 'testing.md',
    });
  }
  if (!evidence.envVars.length && evidence.services.length) {
    items.push({
      question: 'What configuration does this need to boot?',
      why: 'Services are declared but no .env.example documents what they are given.',
      doc: 'runbooks/local-dev.md',
    });
  }
  if (has('data-model.md') && !evidence.entities.length) {
    items.push({
      question: 'Where is the schema declared?',
      why: 'A store was detected but no entity definitions were parsed out of it.',
      doc: 'data-model.md',
    });
  }
  if (!evidence.ci.some((c) => c.commands.some((cmd) => /deploy|release|publish/i.test(cmd)))) {
    items.push({
      question: 'How does this reach production, and how is it rolled back?',
      why: 'No deployment step was found in the scan. Write the rollback first.',
      doc: 'runbooks/deploy.md',
    });
  }
  const merged = mergedAgentDocs(evidence);
  if (merged.length) {
    items.push({
      question: `This repo already had ${merged.join(' and ')} — check the short specd block appended below yours does not contradict what you already say.`,
      why: "Your rules were kept untouched, and specd appended only the four things its own machinery enforces rather than a second set of engineering rules. Anything the two do both mention, yours wins — but only a human can say which is which.",
      doc: 'conventions.md',
    });
  }

  // Instructions for other tools. specd writes neither file, so there is
  // nothing to reconcile *inside* them — but a repo whose Cursor rules and
  // whose AGENTS.md now say different things has the same problem one file
  // further away, and only a human can decide which is right.
  const untouched = evidence.existingAgentDocs.filter((d) => !merged.includes(d));
  if (untouched.length) {
    items.push({
      question: `${untouched.join(' and ')} ${untouched.length === 1 ? 'is' : 'are'} instructions for another tool, and specd left ${untouched.length === 1 ? 'it' : 'them'} alone — do they still agree with AGENTS.md?`,
      why: 'Nothing keeps two sets of agent rules in step. An agent reading only one of them will not know the other exists.',
      doc: 'conventions.md',
    });
  }

  for (const q of drafted?.openQuestions ?? []) {
    if (!q.question) continue;
    const doc = q.doc && has(q.doc) ? q.doc : 'architecture.md';
    items.push({ question: q.question, why: q.why ?? 'Raised by the onboarding scan.', doc });
  }

  const list = items
    .slice(0, 20)
    .map((i) => `- [ ] **${i.question}**\n      ${i.why}\n      → [${i.doc}](${i.doc})`)
    .join('\n');

  return `# Open questions — ${repoName}

${DRAFT_BANNER}

What this knowledge base does not know yet, in the order that costs most to
leave unanswered.

**Agents: an item on this list is not an invitation to guess.** If a task
depends on one of these, say so in the spec and ask. A confident wrong answer
here propagates into every spec that retrieves it afterwards.

${list || '- [ ] _(nothing outstanding — the scan grounded every section it emitted.)_'}

Tick an item by writing the answer into the doc it points at and deleting the
line. When this file is empty, delete it: an empty checklist that survives is
just noise in [README.md](README.md).
`;
}

// ---------------------------------------------------------------------------
// decisions/
// ---------------------------------------------------------------------------

export function renderDecisionsReadme(): string {
  return `# decisions/ — why things are the way they are

An ADR exists so nobody re-litigates a settled choice from scratch, and so an
agent proposing the alternative knows what it is arguing against.

## Index

- [0001 — adopt spec-driven delivery](0001-adopt-spec-driven.md)

New decisions join this list in the PR that adds them. A decision nothing links
to is a decision the next person re-derives.

## When to write one

When a choice closes off an alternative someone would reasonably pick, and the
reason lives outside the code. Not for every library bump.

## Shape

\`\`\`markdown
# 000N — <the decision, as a statement>

- **Status:** proposed | accepted | superseded by [[000M-...]]
- **Date:** YYYY-MM-DD

## Context
What was true that forced a choice. Constraints, not narrative.

## Decision
What was chosen, in the active voice.

## Consequences
What this costs, what it rules out, and what now has to stay true.
\`\`\`

Back to [the map](../README.md).
`;
}

export function renderAdoptionAdr(input: { projectName: string; date: string }): string {
  return `# 0001 — Adopt spec-driven delivery

- **Status:** accepted
- **Date:** ${input.date}
- **Project:** ${input.projectName}

## Context

AI coding agents produce inconsistent results when every session rediscovers the
codebase from raw source. Context evaporates when a session ends, conventions get
reinvented, and assumptions ship silently.

## Decision

Work reaches coding agents as a **human-approved spec**, never as a bare prompt.
Agents read [knowledge/README.md](../README.md) first, cite what they relied on,
and file the as-built spec back into [knowledge/specs/](../specs/README.md) in
the same PR as the code.

The approval gate is structural: no agent may approve its own input.

## Consequences

- Every change is traceable to an approved spec and a named approver.
- \`knowledge/\` must be maintained in the same PR as the code it describes,
  or it rots and the next spec is grounded in fiction.
- Prompt injection via ticket text cannot reach a code-writing agent without
  surviving human review first.
- Gaps become visible instead of being papered over — that is what
  [open-questions.md](../open-questions.md) is for.

More decisions: [decisions/](README.md).
`;
}

// ---------------------------------------------------------------------------
// runbooks/
// ---------------------------------------------------------------------------

export function renderLocalDevRunbook(input: DocContext): string {
  const { repoName, stack, evidence } = input;

  const install = stack.packageManager ? `${stack.packageManager} install` : '# UNVERIFIED — how dependencies are installed';

  const up = evidence.scripts.find((s) => /\b(infra:up|services|docker)$/.test(s.name))?.name;
  const dev = evidence.scripts.find((s) => /\b(dev|start|serve|run)$/.test(s.name))?.name;

  const prerequisites = evidence.services.length
    ? `These must be running first (${plainDoc(evidence.services[0]!.source)}):

${evidence.services.map((s) => `- **${s.name}**${s.image ? ` — \`${s.image}\`` : ''}${s.ports.length ? ` on ${s.ports.join(', ')}` : ''}`).join('\n')}

${up ? `\`\`\`\n${up}\n\`\`\`` : '- UNVERIFIED — the command that starts them.'}`
    : 'UNVERIFIED — runtime versions, services and credentials a newcomer needs.';

  const configSection = evidence.envVars.length
    ? `## Configuration

Copy the example and fill it in — ${plainDoc(evidence.envVars[0]!.source)} is the authoritative list.

| Variable | Note |
| --- | --- |
${evidence.envVars
  .slice(0, 25)
  .map((v) => `| \`${v.name}\` | ${cell(v.note)} |`)
  .join('\n')}
${evidence.envVars.length > 25 ? `\n_${evidence.envVars.length - 25} more in ${plainDoc(evidence.envVars[0]!.source)}._\n` : ''}
`
    : `## Configuration

UNVERIFIED — no \`.env.example\` was found. List the variables this needs, or
commit an example file so the next person does not have to ask.
`;

  return `# Runbook — local development (${repoName})

${DRAFT_BANNER}

## Prerequisites

${prerequisites}

${configSection}
## Run it

\`\`\`
${install}
${dev ? dev : '# UNVERIFIED — the command that actually starts this thing'}
\`\`\`

## Verify

\`\`\`
${verifyCommand(stack, evidence)}
\`\`\`

The same command gates every PR — see [conventions.md](../conventions.md).

## When it breaks

UNVERIFIED — the three failures newcomers actually hit, and the fix for each.
This section is worth more than the rest of the file combined; fill it the
first time you watch someone get stuck.

Deploying instead: [deploy.md](deploy.md).
`;
}

export function renderDeployRunbook(input: DocContext): string {
  const { repoName, evidence } = input;

  const pipelines = evidence.ci.length
    ? evidence.ci
        .map((c) => {
          const commands = c.commands.slice(0, 8).map((cmd) => `  - \`${cmd}\``).join('\n');
          return `- **${c.name ?? c.path}** (${plainDoc(c.path)})${c.triggers.length ? ` — on ${c.triggers.join(', ')}` : ''}\n${commands || '  - UNVERIFIED — no commands parsed.'}`;
        })
        .join('\n')
    : 'UNVERIFIED — no pipeline configuration was found. Name what deploys this, and from where.';

  const containers = evidence.services.length
    ? `\nContainers this repo defines are listed in [architecture.md](../architecture.md#runtime-dependencies).\n`
    : '';

  return `# Runbook — deploy (${repoName})

${DRAFT_BANNER}

## Pipelines

${pipelines}
${containers}
## Environments

UNVERIFIED — what exists, what each is for, and who can deploy to it.

## Deploy

UNVERIFIED — the command or the button, and what to watch while it runs.

## Roll back

UNVERIFIED — the fastest safe path backwards. **Write this section first**; it
is the one that gets read at the worst possible moment.

## Observability

UNVERIFIED — where the logs, metrics and alerts live, and what "healthy" looks
like.

Running it on your own machine instead: [local-dev.md](local-dev.md).
`;
}

// ---------------------------------------------------------------------------
// specs/
// ---------------------------------------------------------------------------

export function renderSpecsReadme(): string {
  return `# knowledge/specs/ — as-built record

Every delivered spec lands here as the final task of its own implementation.
This directory is **append-only**: never rewrite a past spec — if reality
diverged from the approved design, append a \`## Deviations\` section to the
existing file saying what changed and why.

This is the loop that makes context compound. The next spec retrieves these
before it retrieves anything else, so an honest deviation note is worth more
than a tidy history.

- [TEMPLATE.md](TEMPLATE.md) — the shape a spec takes here
- Back to [the map](../README.md)
`;
}

export function renderSpecTemplate(): string {
  return `# <TICKET-ID> — <title>

> spec v1 · status: draft
> approved by <name> on <date>

Three parts, in this order, always. specd generates this shape; the template is
here so a hand-written spec matches what agents already know how to read.

## Requirements

User stories with **EARS** acceptance criteria — testable, observable, singular.

### As a <role>, I want <capability> so that <benefit>.

- **WHEN** <trigger> **THE SYSTEM SHALL** <response>
- **IF** <condition> **THE SYSTEM SHALL** <response>
- **WHILE** <state> **THE SYSTEM SHALL** <response>
- **WHERE** <context> **THE SYSTEM SHALL** <response>

Keywords: \`WHEN\` for events, \`IF\` for conditions, \`WHILE\` for continuous
states, \`WHERE\` for contexts. One observable behaviour per criterion — if it
needs an "and", it is two criteria.

## Design

Claims, each carrying its ground. A claim cites a knowledge doc, or admits it
cannot.

- <claim> _(per knowledge/architecture.md#boundaries)_
- <claim> _(**UNVERIFIED** — what a reviewer must check)_

A citation that cannot be followed is worse than no citation. If the knowledge
base does not answer it, that is an entry for
[open-questions.md](../open-questions.md), not a confident sentence.

### Out of scope

- <what this deliberately does not do>

## Tasks

Ordered, each one PR or less. The last task is always the as-built filing.

- [ ] 1. <task> — S
- [ ] 2. <task> — M
- [ ] 3. commit as-built spec → \`knowledge/specs/<TICKET-ID>-<slug>.md\` — S

## Open questions

- <what the approver must decide before this is implementable>

Back to [the as-built record](README.md).
`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The reference docs this repo earns, in reading order.
 *
 * An optional doc is emitted only when the scan found something to put in it.
 * A page with nothing on it is not neutral — it teaches a reader that this
 * knowledge base is empty, and teaches an agent that the answer is not here.
 */
export function scaffoldDocPaths(evidence: RepoEvidence): string[] {
  return [
    'knowledge/product.md',
    'knowledge/architecture.md',
    'knowledge/conventions.md',
    'knowledge/testing.md',
    ...(hasDataEvidence(evidence) ? ['knowledge/data-model.md'] : []),
    ...(hasIntegrationEvidence(evidence) ? ['knowledge/integrations.md'] : []),
    'knowledge/glossary.md',
    'knowledge/open-questions.md',
  ];
}

/** The complete setup-PR payload for one repo. */
export function renderScaffold(input: {
  repoName: string;
  projectName: string;
  isPrimary: boolean;
  stack: DetectedStack;
  evidence: RepoEvidence;
  date: string;
  agentsMd: string;
  drafted?: DraftedKnowledge | null;
  /**
   * What the repository already has at these paths, so setup adds to a team's
   * agent instructions instead of replacing them. Absent means "not read" —
   * which is treated the same as "not there", so an older caller keeps
   * working, just without the merge.
   */
  existing?: { agentsMd?: string | null; claudeMd?: string | null };
}): ScaffoldFile[] {
  const { repoName, projectName, stack, evidence, date, agentsMd, drafted, existing } = input;
  const docs = scaffoldDocPaths(evidence);
  const ctx: DocContext = { repoName, projectName, stack, evidence, drafted, docs };

  // A repository with its own agreements gets the short specd-specific block,
  // not the whole document — see `renderAgentsSupplement`.
  const mergedAgents = mergeAgentsMd(
    existing?.agentsMd,
    agentsMd,
    renderAgentsSupplement({ isPrimary: input.isPrimary, projectName }),
  );
  const mergedClaude = mergeClaudeMd(existing?.claudeMd);

  const files: ScaffoldFile[] = [
    { path: 'AGENTS.md', content: mergedAgents },
    // `null` means the repo's CLAUDE.md already points at AGENTS.md. Writing
    // it anyway would put an identical file in the PR for a reviewer to read
    // and find nothing in.
    ...(mergedClaude === null ? [] : [{ path: 'CLAUDE.md', content: mergedClaude }]),
    { path: 'knowledge/README.md', content: renderKnowledgeReadme(ctx) },
    { path: 'knowledge/product.md', content: renderProduct(ctx) },
    { path: 'knowledge/architecture.md', content: renderArchitecture(ctx) },
    { path: 'knowledge/conventions.md', content: renderConventions(ctx) },
    { path: 'knowledge/testing.md', content: renderTesting(ctx) },
  ];

  if (hasDataEvidence(evidence)) {
    files.push({ path: 'knowledge/data-model.md', content: renderDataModel(ctx) });
  }
  if (hasIntegrationEvidence(evidence)) {
    files.push({ path: 'knowledge/integrations.md', content: renderIntegrations(ctx) });
  }

  files.push(
    { path: 'knowledge/glossary.md', content: renderGlossary(ctx) },
    { path: 'knowledge/open-questions.md', content: renderOpenQuestions(ctx) },
    { path: 'knowledge/decisions/README.md', content: renderDecisionsReadme() },
    {
      path: 'knowledge/decisions/0001-adopt-spec-driven.md',
      content: renderAdoptionAdr({ projectName, date }),
    },
    { path: 'knowledge/runbooks/local-dev.md', content: renderLocalDevRunbook(ctx) },
    { path: 'knowledge/runbooks/deploy.md', content: renderDeployRunbook(ctx) },
    { path: 'knowledge/specs/README.md', content: renderSpecsReadme() },
    { path: 'knowledge/specs/TEMPLATE.md', content: renderSpecTemplate() },
  );

  return files;
}

/** The setup PR description. It says exactly what the drafts are worth (§6). */
export function renderSetupPrBody(input: {
  repoName: string;
  projectName: string;
  fileCount: number;
  unverifiedCount: number;
  stackLine: string;
  evidence: RepoEvidence;
  drafted: boolean;
}): string {
  const { evidence } = input;

  const read = [
    `${evidence.fileCount} tracked files`,
    evidence.scripts.length ? `${evidence.scripts.length} declared commands` : null,
    evidence.ci.length ? `${evidence.ci.length} CI pipeline(s)` : null,
    evidence.services.length ? `${evidence.services.length} runtime service(s)` : null,
    evidence.envVars.length ? `${evidence.envVars.length} configuration variable(s)` : null,
    evidence.entities.length ? `${evidence.entities.length} entity name(s)` : null,
    evidence.tests.fileCount ? `${evidence.tests.fileCount} test file(s)` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Named up front, because "did this thing rewrite our AGENTS.md?" is the
  // first question a reviewer of this PR has, and the diff is the second.
  const merged = mergedAgentDocs(evidence);
  const kept = merged.length
    ? `\n\n> **Your existing ${merged.join(' and ')} ${
        merged.length === 1 ? 'was' : 'were'
      } kept.** Nothing in ${
        merged.length === 1 ? 'it' : 'them'
      } was rewritten. specd appended a short block — the four rules its own\n> machinery enforces, and where the knowledge base lives — rather than a second\n> set of engineering rules on top of yours. It is fenced by\n> \`<!-- specd:begin -->\` markers, so a later setup run updates only that block.`
    : '';

  return `## specd setup — review me, then merge to adopt

This PR installs the working agreements and knowledge base for **${input.projectName}**.

**${input.fileCount} files.** Detected stack: ${input.stackLine}.${kept}

### What the scan read

${read}

Tables built from those files name their source and are **not** marked
UNVERIFIED — they are quotations, not claims. ${
    input.drafted
      ? 'Everything else was drafted by a model from the same evidence.'
      : '**No AI credential was available**, so the judgement sections are empty and marked with the question each one exists to answer.'
  }

### Read this before you merge

The scan can see your files; it cannot see your intent. Every claim it could not
ground is marked **UNVERIFIED** — there are **${input.unverifiedCount}** of them,
and \`knowledge/open-questions.md\` lists them in the order that costs most to
leave unanswered.

**Do not treat generated text as verified.** Review it the way you would review
a new hire's first architecture write-up: the shape is useful, the details need
your judgement. Merging is adopting.

### After merging

1. Work the checklist in \`knowledge/open-questions.md\` from the top. The
   product doc and the architecture boundaries pay for themselves fastest.
2. Write or import your first ticket.
3. Generate your first spec, review it, and stamp it.

_Opened by specd · git stays the source of truth for knowledge; the platform
only holds a derived index._
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The agent docs the scan found that setup actually merges into.
 *
 * `existingAgentDocs` is wider than that — it also names `.cursorrules` and
 * Copilot instructions, which specd never writes. Saying "your existing
 * .cursorrules was kept, specd's rules were appended below it" would be a
 * claim about a file this PR does not touch.
 */
function mergedAgentDocs(evidence: RepoEvidence): string[] {
  return evidence.existingAgentDocs.filter((d) => d === 'AGENTS.md' || d === 'CLAUDE.md');
}

/**
 * A drafted slot, or the question it exists to answer. The fallback is phrased
 * as an instruction to a human because that is who reads an empty section.
 */
function draftedOr(body: string | undefined, ask: string): string {
  const text = body?.trim();
  return text ? text : `UNVERIFIED — ${ask}`;
}

/**
 * A path to a file *outside* knowledge/, rendered so link extraction does not
 * mistake it for a doc reference. Backticked `docs/x.md` becomes a graph edge
 * that cannot resolve, and a knowledge base that ships broken links greets its
 * new owner with a health warning about docs they never wrote (S-102).
 */
function plainDoc(path: string): string {
  return path.endsWith('.md') ? path : `\`${path}\``;
}

function inlineCode(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  const clipped = flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
  return `\`${clipped.replace(/`/g, "'")}\``;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Text read out of a file, made safe for a table cell. An unescaped `|` in a
 * comment ("claude-opus-5 | claude-sonnet-5") silently splits the row and the
 * table stops rendering — a doc that breaks on the repo's own content.
 */
function cell(text: string | undefined, max = 110): string {
  const flat = text?.replace(/\s+/g, ' ').trim();
  if (!flat) return '—';
  if (flat.length <= max) return escapePipes(flat);
  const cut = flat.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  return escapePipes(`${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`);
}

function verifyDetected(stack: DetectedStack, evidence: RepoEvidence): boolean {
  return Boolean(stack.verifyCommand) || evidence.ci.some((c) => c.commands.length > 0);
}

/**
 * The command that gates a PR. A CI pipeline that names it is better evidence
 * than a guess assembled from script names, so it wins.
 */
function verifyCommand(stack: DetectedStack, evidence: RepoEvidence): string {
  if (stack.verifyCommand) return stack.verifyCommand;

  const fromCi = evidence.ci
    .flatMap((c) => c.commands)
    .find((cmd) => /\b(test|check|verify|lint|vet)\b/.test(cmd));
  if (fromCi) return fromCi;

  return '# UNVERIFIED — no verify command detected; add yours here';
}
