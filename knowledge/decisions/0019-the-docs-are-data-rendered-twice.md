# 0019 — The documentation is data, rendered twice

- **Status:** accepted
- **Date:** 2026-08-14
- **Project:** specd

## Context

specd had two documentation surfaces and neither worked.

`README.md` carried everything — the pitch, the quick start, the engine, the
CLI, the integrations, the invariants — at 33 KB, in one column, with no way in
for someone who had not already decided to read all of it. `/docs` in the web
app was 80 lines of TSX: a five-line quickstart, five core concepts, five CLI
commands, and a promise that the "full reference ships with P1."

Neither was reachable by the person who most needed them. The repository is
private and the web app needs Postgres, an API and a `.env` before it serves a
single page, so "read the docs" meant "clone the platform first." Every project
specd benchmarked ([[graphify-engine-analysis]], [[semantica-analysis]])
publishes a documentation site as the front door; specd published nothing.

The obvious fix — write a static site — creates the problem it is supposed to
solve. Two copies of the same words drift, and the stale one always wins an
argument nobody knew they were having. `knowledge/` exists in this repository
precisely because a document that can silently disagree with reality is worse
than no document ([[0001-adopt-spec-driven]]).

## Decision

Author the documentation **once, as data**, in `apps/web/lib/docs/`, and render
it from two independent renderers: React for the in-app `/docs`, and HTML for
the published GitHub Pages site.

- **A block union, not markdown.** `Block` is thirteen kinds — prose, headings,
  lists, definition rows, code, tables, callouts, steps, cards, pull quotes.
  Markdown would mean a parser dependency in the web app and a second one in a
  build script, and it buys expressiveness these pages do not need: a
  comparison table with a tone-carrying callout beside it is raw HTML in
  markdown anyway. The tiny inline syntax (`` `code` ``, `**strong**`,
  `[label](href)`, `_em_`) is 20 lines and shared by both renderers, so a
  passage cannot render one way in the app and another on the site.
- **No imports out of `lib/docs/`.** The static generator loads these modules
  through `tsx` with no bundler, no path aliases and no React. An
  `@/components/…` import would break the published site while leaving
  `pnpm typecheck` and every test perfectly green — the exact failure shape
  this repository keeps refusing to ship.
- **The corpus is tested, because data can be wrong in ways a type cannot
  catch.** `lib/docs/docs.test.ts` asserts unique slugs, table rows the width of
  their header, no two headings collapsing to one anchor, every internal
  `/docs/…` link resolving to a real page, and every block kind being one *both*
  renderers know. A renamed page is invisible in review and obvious to a
  reader.
- **Every link the generator emits is relative.** GitHub Pages serves a project
  site from `/specd/`, and a custom domain from `/`. Relative links are the only
  kind that work in both without a base-path setting to keep in sync — so one
  build serves either, and `scripts/site/check-links.mjs` resolves all ~1,760 of
  them against the files on disk rather than trusting the arithmetic.
- **Nothing generated is committed.** `pnpm site:build` writes to `/site/`,
  which is gitignored; CI builds and uploads it straight to Pages. A checked-in
  copy would be a third source of truth for the same words.
- **The generator is typechecked separately.** `tsx` transpiles without
  checking, so `scripts/site/tsconfig.json` plus `pnpm site:typecheck` exist and
  run in the Pages workflow. It is deliberately *not* in `pnpm typecheck` — that
  gate is the workspace packages, and `knowledge/conventions.md` commits to it
  verbatim.

## Consequences

Thirty-one pages across six categories, written for two audiences that
previously had none: someone deciding whether spec-driven delivery is worth the
review step, and someone who needs the flag they half-remember. Every page
declares who it is for and how long it takes, and the pages are ordered so
reading straight down the rail is a coherent path rather than an alphabet.

The README stops being the only door. It keeps every substantive claim, but the
procedural bulk — the by-hand setup, the integration walkthroughs, the runbook —
folds into `<details>` and links out. What it gained is a first screen: the
claim, three lines of install, and a screenshot of a real spec under review.

Headings are stripped of their inline markers rather than rendered with them
(`headingText`). A heading appears in three places — the display face, the
contents rail, and an anchor — and a `<code>` chip would have to be styled to
match in all three. The cost is that a heading cannot carry a link, which a test
now asserts rather than leaves to be discovered.

The published site cannot be deployed yet, and the workflow says so honestly
rather than appearing to work. `unitypark/specd` is private on an account whose
plan does not include Pages for private repositories, so the `deploy` job fails
while `build` passes. The two ways out — make the repository public, or upgrade —
are both the owner's, not the workflow's. The README's
`unitypark.github.io/specd/docs/…` links are dead until then, which is
self-consistent: nobody outside can read the README either.

`docs/*.md` at the repository root survives unchanged. Those files are
procedure — registering a GitHub App by hand, every `curl` call for Jira — and
duplicating a procedure into the block vocabulary would have created exactly
the second copy this decision exists to prevent. The docs site links to them
instead.
