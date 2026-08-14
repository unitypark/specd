# 0017 — The knowledge engine answers over MCP, read-only

- **Status:** accepted
- **Date:** 2026-08-13
- **Project:** specd

## Context

specd spent two research rounds building a retrieval engine worth citing:
three bounded stages with provenance on every expansion, six deterministic link
kinds, a symbol index, drift measured against the code a doc historically moves
with, and four citation verdicts that distinguish "checked and wrong" from
"could not check" ([[0014-the-index-holds-code-not-only-docs]],
[[0013-doc-code-coupling-from-git-history]]).

It has exactly one consumer: the SpecAgent, in-process. `retrieve()` was never
exposed over HTTP, and `judgeCitation` was module-private to the agent. An
engineer working in Claude Code — the case specd exists to serve — could reach
none of it. They got `AGENTS.md`, which *tells* them to read `knowledge/`, and
`specd spec pull`. To actually use the knowledge base they grepped the
repository, which is the problem the knowledge base was built to solve.

[[semantica-analysis]] is the third benchmarked project in a row to answer this
the same way: a protocol surface with tools for questions and resources for
ambient state. graphify shipped one in round № 1. At that point it stops being
a data point about other people's products.

## Decision

Serve the engine over MCP from the CLI binary — `specd mcp serve` — as a thin
client over the same HTTP API every other command uses.

- **Read-only by construction, not by convention.** The server carries the same
  CLI-audience token as every other command, and the API refuses a CLI token on
  every route not marked `@CliAllowed` (`apps/api/src/auth/auth.guard.ts:44-56`).
  An agent cannot approve a spec through this server because the *server*
  cannot, however it is asked. The four new routes are `@Get`s on
  `CliController`, and `cli.controller.test.ts` asserts that `connect` remains
  the only non-read on that class — the decorator applies to the next route
  somebody adds, so the invariant is asserted rather than remembered.
- **In the Go binary, not a new service.** The CLI already resolves the API
  URL, holds the keychain token, and knows the project. A separate process
  would duplicate all three and add a second thing to install.
- **JSON-RPC hand-rolled over stdio.** No MCP SDK, no JSON-RPC dependency: the
  protocol surface we use is `initialize`, `ping`, `tools/list`, `tools/call`,
  `resources/list`, `resources/read`, and notifications. `encoding/json` covers
  it in one file. [[0006-cli-repl-bubbletea]] established that dependencies are
  acceptable when they earn it; this one does not yet.
- **`judgeCitation` moved to `packages/shared`.** `KnowledgeService` needed it
  and importing the agent from the service would have been a cycle. It sits
  beside `renderAsBuiltMarkdown` for the same stated reason: more than one
  caller must produce the same answer, and a citation that is `supported` in a
  spec and `unsupported` when anyone checks it makes the verdict worthless.
- **A tool failure is a result, not a protocol error.** "This spec is not
  approved" is an answer the agent should read and stop on. Returning a
  JSON-RPC error would make the client treat it as a broken server and retry.
  Failures come back as content with `isError`; the gate's refusal comes back
  as ordinary content, because the gate refusing a draft is the product
  working.
- **stdout carries the protocol and nothing else.** Every other command in this
  CLI prints freely to stdout. Here a stray `fmt.Println` corrupts the stream
  and the client disconnects, so diagnostics go to stderr and a test asserts
  that `serve()` emits one JSON frame per request and none for a notification.
- **Not in the REPL.** Every other command is registered in `replCommands`. A
  long-lived stdio server that owns stdin and stdout is not something to launch
  inside a Bubbletea TUI that owns both, so `specd mcp serve` is deliberately
  absent from the slash-command table.

## Consequences

Seven tools and three resources. The tools are the questions an agent actually
has — `search_knowledge`, `get_doc`, `verify_citation`, `knowledge_health`,
`spec_status`, `spec_pull`, `list_specs`. The resources are ambient state that
should not cost a tool call: knowledge health, specs awaiting review, and the
project summary.

Search results carry the `CITE-AS` string the server computed, not one the
client assembles. A citation built by hand is a citation the validator then
judges `unsupported`, and the layout matches the SpecAgent's own prompt so a
passage read here and cited in a spec was seen in the same shape both times.

`verify_citation` answers a slightly narrower question than the same verdict
inside a spec draft, and the service documents the difference: retrieval runs
*for that citation*, so `unknown` means the corpus could not surface the passage
even when asked directly, rather than that it missed the top-k of a broader
query. Both remain "could not check", which is the distinction the four-verdict
design exists to protect.

`get_doc` takes a path, which is what an agent holds — but `knowledge_docs` is
unique on `(repository_id, path)` and onboarding scaffolds identical filenames
into every repo it grounds, so a path alone does not identify a document. The
lookup orders primary-repo-first for a stable answer, accepts an optional repo
name, and reports which repository answered.

`cli/cmd/specd/mcp_test.go` is the first HTTP test in this repository —
`api.New()` already takes an arbitrary base URL, so `httptest` needed no
production change. The alternative was leaving the gate's behaviour over MCP
unverified, which is not a trade worth making for consistency with an absence.

Two consequences found in review, both recorded rather than designed around.

`verify_citation` must never answer `unsupported` for a path that exists.
Retrieval serves source code as citable excerpts, but `coverageFor` builds its
`knownPaths` from `knowledge_docs` alone — so an agent citing exactly what
`search_knowledge` handed it could be told "checked and wrong. Do not cite
this" about a file that is really indexed. Inside a spec draft this could not
happen, because coverage and chunks come from one retrieval and a code citation
always matches an excerpt exactly; checking one on demand has no such
guarantee. The verdict now falls to `unknown` when the path is indexed source
code, which is what the fourth verdict is for.

`search_knowledge` and `verify_citation` both embed their query, and an agent
loop is the intended caller. With the default lexical embedder that is free and
local. With `SPECD_EMBEDDING_PROVIDER=voyage` it is a paid API call per
request, unrated and unmetered — `@Max(30)` bounds one response, not the
request rate. No limit is imposed here; the exposure is named so that whoever
configures a paid embedder knows what they have opened.

The knowledge routes are on `CliController` rather than a knowledge controller
because `@CliAllowed` is what makes them reachable, and moving them elsewhere
would mean re-deriving that decision per route. The cost is that the CLI
controller now serves something the CLI itself does not call.
