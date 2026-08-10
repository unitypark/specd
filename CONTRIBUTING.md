# Contributing

Thanks for looking. Two things make this repository unusual to contribute to,
and both are the product working as intended.

## Knowledge first

specd develops specd. The working agreements in [`AGENTS.md`](AGENTS.md) bind
humans and agents alike:

1. Read [`knowledge/README.md`](knowledge/README.md) and the docs it maps to
   your change before implementing. Don't re-derive what is written down.
2. Ground design choices in `knowledge/` and cite what you relied on in the PR
   description (e.g. `per knowledge/decisions/0012-….md`).
3. **Docs ride the change** — update `knowledge/` in the same PR as the code
   it describes. A doc that trails its code is how knowledge bases rot, and
   this one measures its own rot.
4. `knowledge/specs/` is append-only history. Never rewrite an old spec; add a
   `## Deviations` section if reality diverged.

## The gate

```bash
pnpm typecheck && pnpm test
```

That is the whole verify command, and CI runs exactly it — plus a check that
the Postgres-dependent suites actually ran rather than skipping themselves.
Bring the database up (`pnpm infra:up && pnpm db:migrate`) before trusting a
green run on anything touching the index, retrieval, runs or webhooks.

A few conventions the codebase holds itself to, which reviews will hold you to:

- **Measure, don't assert.** Claims about quality or performance come with the
  probe or eval that produced them (`pnpm eval`; day-two notes in
  [`knowledge/runbooks/local-dev.md`](knowledge/runbooks/local-dev.md)).
- **Check a test's teeth.** A regression test should fail against the code it
  guards — verify that before landing it, and say so in the PR.
- **Signals never cry wolf.** "Couldn't check" is a different answer from
  "checked and wrong"; "unmeasured" is different from "fine". New signals
  follow that discipline or they don't ship.
- Plain SQL migrations in `packages/db/migrations/`, updated alongside the
  Drizzle schema — nothing checks they agree, so you must.
- Sequential PRs against `main`; no stacked bases.

## Practical bits

- First-run setup is in the [README](README.md#quick-start); day-two loop in
  [`knowledge/runbooks/local-dev.md`](knowledge/runbooks/local-dev.md).
- Branch naming for spec-driven work: `spec/<id>-<slug>` (AGENTS.md rule 6);
  anything else descriptive is fine for ordinary changes.
- Security problems go through [`SECURITY.md`](SECURITY.md), not issues.
