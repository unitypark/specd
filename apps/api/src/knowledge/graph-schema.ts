/**
 * The knowledge graph's vocabulary, declared once.
 *
 * Link kinds were previously spread across three places that had to agree by
 * hand: the extractor knew the syntaxes, the retriever knew the weights, and
 * the docs described both. Nothing checked them against each other, so a
 * fifth kind would silently take the fallback weight and the prose would
 * quietly go stale — the same drift the benchmarked engine hit in exactly the
 * one table it maintained by hand
 * (per knowledge/research/code-graph-rag-engine-analysis.md#7-the-clever-parts).
 *
 * Everything below has more than one consumer: the extractor's type, the
 * retriever's weights, an integrity audit against the stored rows, and a
 * generated section of knowledge/architecture.md that a test holds to this
 * file. Adding a kind here is the whole change; forgetting to update a
 * consumer is a type error or a failing test rather than a silent 0.3.
 */

export interface LinkKindSpec {
  kind: string;
  /**
   * Expansion weight. Authored intent outranks incidental mention: someone
   * writing "per architecture.md#auth" is making a claim about relevance in a
   * way that a backticked path in a sentence is not.
   */
  weight: number;
  /** How it is written, for the docs and for anyone debugging an edge. */
  syntax: string;
  description: string;
}

export const LINK_KINDS = [
  {
    kind: 'citation',
    weight: 1.0,
    syntax: 'per knowledge/architecture.md#auth',
    description: 'An explicit grounding claim — the strongest signal a doc gives about another.',
  },
  {
    kind: 'wikilink',
    weight: 0.9,
    syntax: '[[0004-runner-job-dispatch]] · [[S-104]]',
    description: 'A deliberate cross-reference by stem, resolved against doc names and spec ids.',
  },
  {
    kind: 'mdlink',
    weight: 0.6,
    syntax: '[text](../decisions/0011-specd-develops-specd.md)',
    description: 'An ordinary markdown link. Intentional, but often navigational rather than evidential.',
  },
  {
    kind: 'symbolref',
    weight: 0.7,
    syntax: '`RunnerJobsService.claim()`',
    description:
      'A named declaration in the code. Resolved only when exactly one indexed symbol matches, and dropped otherwise — there is no way to tell a deleted symbol from a word that was never one, so it never reports as broken.',
  },
  {
    kind: 'coderef',
    weight: 0.5,
    syntax: '`apps/api/src/runners/runner-jobs.service.ts`, or the same path bare in prose',
    description:
      'A reference to source code rather than to another doc. Resolves against the indexed file tree, so a doc pointing at a file that no longer exists says so.',
  },
  {
    kind: 'pathref',
    weight: 0.4,
    syntax: '`decisions/0008-remove-unused-queue.md`, or the same path bare in prose',
    description: 'A mention of a doc by path. Real, and the weakest of the four.',
  },
] as const satisfies readonly LinkKindSpec[];

export type LinkKind = (typeof LINK_KINDS)[number]['kind'];

/**
 * Weight per kind, derived rather than restated. Typed as a total map over
 * LinkKind, so a new kind cannot be added without a weight — the case that
 * used to fall through to an unexplained default.
 */
export const EDGE_WEIGHT: Record<LinkKind, number> = Object.fromEntries(
  LINK_KINDS.map((k) => [k.kind, k.weight]),
) as Record<LinkKind, number>;

/**
 * `unresolved` is kept rather than dropped — flag, don't drop — and
 * `dangling_anchor` is deliberately distinct from it: the doc is real and the
 * section is not, which is a different repair.
 */
export const RESOLUTION_STATES = ['resolved', 'unresolved', 'dangling_anchor'] as const;
export type ResolutionState = (typeof RESOLUTION_STATES)[number];

/**
 * Producers of edges. Only one today; the column exists so a later
 * LLM-derived tier can coexist and be replaced independently (S-102).
 */
export const ORIGIN_TIERS = ['deterministic'] as const;
export type OriginTier = (typeof ORIGIN_TIERS)[number];

/** Markers a generated docs section lives between. */
export const VOCABULARY_BEGIN = '<!-- generated:graph-vocabulary — edit graph-schema.ts, not this -->';
export const VOCABULARY_END = '<!-- /generated:graph-vocabulary -->';

/** The docs consumer. Held to this file by a test rather than by discipline. */
export function renderGraphVocabulary(): string {
  const rows = LINK_KINDS.map(
    (k) => `| \`${k.kind}\` | ${k.weight.toFixed(1)} | ${k.syntax} | ${k.description} |`,
  ).join('\n');

  return [
    VOCABULARY_BEGIN,
    '',
    'Deterministically extracted from doc text at index time — no model call is',
    'made during extraction, because a hallucinated edge poisons retrieval',
    'invisibly. Weight orders one-hop expansion; it never mixes with RRF scores.',
    '',
    '| Kind | Weight | Written as | Meaning |',
    '| --- | --- | --- | --- |',
    rows,
    '',
    `Resolution states: ${RESOLUTION_STATES.map((s) => `\`${s}\``).join(', ')}. ` +
      `Producer tiers: ${ORIGIN_TIERS.map((t) => `\`${t}\``).join(', ')}.`,
    '',
    VOCABULARY_END,
  ].join('\n');
}
