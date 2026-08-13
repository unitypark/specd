# 0015 — Onboarding reads the repository before it drafts

- **Status:** accepted
- **Date:** 2026-08-13

## Context

The Ground station opened a setup PR whose knowledge base was, in practice,
mostly empty. `architecture.md` had one grounded line (the file tree) and three
sections saying UNVERIFIED. `conventions.md` had a stack table. Both runbooks
were stubs in which every heading was a placeholder. A reviewer's honest
summary was "this is a template, not a knowledge base," and the docs that a
spec most needs to retrieve — what the system is *for*, what a change must pass
before it merges, what has to be running to boot it — were the ones with
nothing in them.

The cause was not the prompt. It was that the scan opened seventeen root
manifests and nothing else, so the model was asked to describe a system from a
directory listing. Marking the resulting guesses UNVERIFIED was correct and
kept us honest (§6), but a page of honest UNVERIFIED markers still fails the
job: the first impression of the product is a wiki with no facts in it.

Meanwhile the answers were sitting in files the scan declined to read. CI
workflows state the verify command. Compose files state the runtime
dependencies. `.env.example` states the configuration surface. Migrations and
schema files state the nouns. None of that needs a model at all.

## Decision

**Read more, infer less.** Three changes, in that order of importance:

1. The scan is a tiered, capped *selector* (`apps/api/src/vcs/scan-targets.ts`),
   not seventeen filenames: root manifests, CI pipelines, container and compose
   files, tool configuration, workspace manifests, schema and migration files,
   existing docs, and entry points. Around fifty files instead of six, read
   eight at a time, deterministic in and out. Tiers are capped individually so
   a monorepo's two hundred `package.json` files cannot crowd out its one CI
   workflow.

2. Facts are extracted deterministically before any model call
   (`packages/templates/src/evidence.ts`) and rendered into the docs as tables
   that name their source file. These are **not** marked UNVERIFIED, because
   they are quotations rather than claims.

3. The model is asked for *sections*, not documents
   (`DRAFT_SCHEMA` in `apps/api/src/agents/onboarding.agent.ts`) — the
   judgement a scan cannot make: boundaries, code style, what a reviewer
   rejects, what the domain words mean, what a human still has to answer. It
   never restates the evidence tables, so it cannot get them subtly wrong.

The scaffold grew to match: `product.md` (requirements are drafted against it),
`testing.md`, `open-questions.md`, `specs/TEMPLATE.md`, `decisions/README.md`,
and — only when the scan found something to put in them — `data-model.md` and
`integrations.md`.

## Consequences

- The two kinds of content are visibly separate in every generated doc, so a
  reviewer can tell at a glance what was read from what was inferred. This is
  §6 held more tightly than before, not loosened.
- A repo with no AI credential now gets a genuinely useful knowledge base:
  commands, pipelines, services, configuration, entities and test layout are
  all model-free. Only the judgement sections stay empty, each carrying the
  question it exists to answer.
- Widening a net that ships file contents to a model provider makes the
  sensitive-path filter load-bearing: `.env`, keys, certificates and
  credentials files are refused by path before they are ever read
  (`isSensitivePath`), whatever tier would otherwise match them.
- Optional docs are conditional, so any doc that links to one must ask whether
  it exists — a link to a `data-model.md` that was never emitted is a broken
  edge in the knowledge graph, which is the failure
  [[S-102]] existed to prevent.
  The scaffold graph test now runs both shapes.
- Onboarding costs more: ~50 file reads instead of ~6, and a larger prompt at a
  32k output budget instead of 16k. It runs once per repository, and the
  alternative is a knowledge base nobody trusts.
- `detectStack` reads workspace manifests too. A NestJS monorepo used to be
  detected as "JavaScript, no framework", because in a workspace the root
  manifest is a task runner and every real dependency is one level down.

The rest of the index: [knowledge/README.md](../README.md#decisions).
