import { describe, expect, it } from 'vitest';
import { countCitations, countUnverified, type RetrievedChunk, type SpecContent } from '@specd/shared';
import { normalizeSpecContent } from './spec.agent.js';

const chunks: RetrievedChunk[] = [
  {
    docId: 'd1',
    repoName: 'aurora-api',
    path: 'knowledge/architecture.md',
    heading: 'contacts',
    text: 'Contacts go through the list-query builder.',
    score: 0.9,
    via: 'both',
  },
  {
    docId: 'd2',
    repoName: 'aurora-api',
    path: 'knowledge/decisions/0003-file-delivery.md',
    heading: null,
    text: 'Large files are delivered via signed URLs.',
    score: 0.7,
    via: 'vector',
  },
  {
    // A chunk the flat RRF shot missed and graph expansion pulled in (S-102).
    docId: 'd3',
    repoName: 'aurora-api',
    path: 'knowledge/decisions/0007-signed-url-ttl.md',
    heading: 'decision',
    text: 'Signed URLs expire after 15 minutes.',
    score: 0,
    via: 'graph',
    viaEdge: 'citation at knowledge/decisions/0003-file-delivery.md#context',
  },
];

const ctx = {
  ticketKey: 'CRM-142',
  slug: 'export-contacts',
  primaryRepo: 'aurora-api',
  chunks,
};

function draft(overrides: Partial<SpecContent> = {}): SpecContent {
  return {
    requirements: [{ story: 'As a user…', criteria: [{ keyword: 'WHEN', trigger: 't', response: 'r' }] }],
    design: [],
    tasks: [{ id: 'T1', title: 'build it', size: 'M' }],
    ...overrides,
  };
}

describe('spec normalization', () => {
  it('keeps a citation that resolves to a retrieved chunk', () => {
    const out = normalizeSpecContent(
      draft({ design: [{ text: 'reuse the builder', citation: 'knowledge/architecture.md#contacts' }] }),
      ctx,
    );
    expect(out.design[0]?.citation).toBe('knowledge/architecture.md#contacts');
    expect(out.design[0]?.unverified).toBeUndefined();
  });

  it('accepts a citation to a retrieved file without its anchor', () => {
    const out = normalizeSpecContent(
      draft({ design: [{ text: 'signed URLs', citation: 'knowledge/decisions/0003-file-delivery.md' }] }),
      ctx,
    );
    expect(out.design[0]?.citation).toBeTruthy();
  });

  it('accepts a citation to a chunk that arrived via graph expansion (S-102)', () => {
    // The whole point of widening retrieval: what the graph pulled in is as
    // citable as what RRF found, because it was genuinely retrieved.
    const out = normalizeSpecContent(
      draft({
        design: [{ text: 'links expire quickly', citation: 'knowledge/decisions/0007-signed-url-ttl.md#decision' }],
      }),
      ctx,
    );
    expect(out.design[0]).toMatchObject({
      citation: 'knowledge/decisions/0007-signed-url-ttl.md#decision',
    });
    expect(out.design[0]!.unverified).toBeUndefined();
  });

  it('demotes a citation to a document that was never retrieved', () => {
    // The dangerous case: a plausible-looking path the reviewer would skim
    // past. It must not survive as a citation.
    const out = normalizeSpecContent(
      draft({ design: [{ text: 'per the auth doc', citation: 'knowledge/auth-design.md#tokens' }] }),
      ctx,
    );
    expect(out.design[0]?.citation).toBeUndefined();
    expect(out.design[0]?.unverified).toContain('not in the retrieved knowledge');
  });

  it('marks an uncited claim unverified rather than leaving it bare', () => {
    const out = normalizeSpecContent(draft({ design: [{ text: 'retention is 24h' }] }), ctx);
    expect(out.design[0]?.unverified).toBeTruthy();
  });

  it('preserves the model’s own unverified note when it gave one', () => {
    const out = normalizeSpecContent(
      draft({ design: [{ text: 'retention is 24h', unverified: 'ask sales ops' }] }),
      ctx,
    );
    expect(out.design[0]?.unverified).toBe('ask sales ops');
  });

  it('appends the as-built task when the model forgot it', () => {
    const out = normalizeSpecContent(draft(), ctx);
    const last = out.tasks.at(-1);
    expect(last?.title).toContain('knowledge/specs/CRM-142-export-contacts.md');
    expect(last?.asBuilt).toBe(true);
    expect(last?.repo).toBe('aurora-api');
  });

  it('does not duplicate an as-built task the model already wrote', () => {
    const out = normalizeSpecContent(
      draft({
        tasks: [
          { id: 'T1', title: 'build it', size: 'M' },
          { id: 'T2', title: 'commit as-built spec to knowledge/specs/', size: 'S' },
        ],
      }),
      ctx,
    );
    const asBuiltTasks = out.tasks.filter((t) => /as-built/i.test(t.title));
    expect(asBuiltTasks).toHaveLength(1);
    expect(out.tasks.at(-1)?.asBuilt).toBe(true);
  });

  it('backfills missing task ids', () => {
    const out = normalizeSpecContent(
      draft({ tasks: [{ id: '', title: 'nameless', size: 'S' }] }),
      ctx,
    );
    expect(out.tasks[0]?.id).toBe('T1');
  });

  it('throws rather than inventing content when the model returned nothing', () => {
    expect(() => normalizeSpecContent(undefined, ctx)).toThrow(/no structured content/);
  });

  it('strips a duplicated "THE SYSTEM SHALL" from the response', () => {
    // The renderer supplies the connective, so a model that includes it too
    // produces "THE SYSTEM SHALL THE SYSTEM SHALL …" in the spec handed to a
    // coding agent. Observed in real output; normalised rather than prompted.
    const out = normalizeSpecContent(
      draft({
        requirements: [
          {
            story: 'As a user…',
            criteria: [
              { keyword: 'WHEN', trigger: 'x happens,', response: 'THE SYSTEM SHALL do y' },
              { keyword: 'WHILE', trigger: 'y holds', response: 'the system shall do z' },
              { keyword: 'IF', trigger: 'z fails', response: 'SHALL retry' },
              { keyword: 'WHEN', trigger: 'w', response: 'already clean' },
            ],
          },
        ],
      }),
      ctx,
    );

    expect(out.requirements[0]?.criteria.map((c) => c.response)).toEqual([
      'do y',
      'do z',
      'retry',
      'already clean',
    ]);
  });

  it('trims the trailing comma models leave on triggers', () => {
    const out = normalizeSpecContent(
      draft({
        requirements: [
          {
            story: 's',
            criteria: [{ keyword: 'WHEN', trigger: 'a user signs in,  ', response: 'redirect' }],
          },
        ],
      }),
      ctx,
    );
    expect(out.requirements[0]?.criteria[0]?.trigger).toBe('a user signs in');
  });

  it('drops a keyword the model repeated inside the trigger', () => {
    const out = normalizeSpecContent(
      draft({
        requirements: [
          {
            story: 's',
            criteria: [{ keyword: 'WHEN', trigger: 'WHEN a user signs in', response: 'redirect' }],
          },
        ],
      }),
      ctx,
    );
    expect(out.requirements[0]?.criteria[0]?.trigger).toBe('a user signs in');
  });

  it('always yields the optional sections as arrays', () => {
    const out = normalizeSpecContent(draft(), ctx);
    expect(out.outOfScope).toEqual([]);
    expect(out.openQuestions).toEqual([]);
  });
});

/**
 * Three-verdict citation checking (plan 2.1). Without coverage the checker can
 * only ask "was this retrieved", so a real doc that missed the top-k is
 * reported exactly like an invented one. Coverage is what separates "checked
 * and wrong" from "could not check" — and the second is not a softer version
 * of the first, it is a different answer that points at a different fix.
 */
describe('citation verdicts', () => {
  const coverage = {
    knownPaths: [
      'knowledge/architecture.md',
      'knowledge/decisions/0003-file-delivery.md',
      'knowledge/decisions/0007-signed-url-ttl.md',
      // Real, indexed, but not retrieved for this query.
      'knowledge/runbooks/deploy.md',
      // Real, but holds no chunk — retrieval can never surface it.
      'knowledge/glossary.md',
    ],
    anchorsByPath: {
      'knowledge/architecture.md': ['contacts', 'auth'],
      'knowledge/decisions/0003-file-delivery.md': ['context', 'decision'],
      'knowledge/decisions/0007-signed-url-ttl.md': ['decision'],
    },
    unretrievablePaths: ['knowledge/glossary.md'],
    truncatedCount: 0,
  };
  const withCoverage = { ...ctx, coverage };

  const judge = (citation: string, cov = coverage) =>
    normalizeSpecContent(draft({ design: [{ text: 'a claim', citation }] }), {
      ...ctx,
      coverage: cov,
    }).design[0]!;

  it('supports a citation that matches a retrieved chunk exactly', () => {
    const claim = judge('knowledge/architecture.md#contacts');
    expect(claim.verdict).toBe('supported');
    expect(claim.citation).toBe('knowledge/architecture.md#contacts');
    expect(claim.unverified).toBeUndefined();
  });

  it('rejects a doc that does not exist as unsupported', () => {
    // Checked, and there is nothing there. Worth acting on.
    const claim = judge('knowledge/auth-design.md#tokens');
    expect(claim.verdict).toBe('unsupported');
    expect(claim.citation).toBeUndefined();
    expect(claim.unverified).toContain('no such doc');
  });

  it('rejects a section that does not exist in a retrieved doc as unsupported', () => {
    // The loose-anchor hole: this used to be accepted because the *path* was
    // retrieved, so a hallucinated anchor survived review looking checked.
    const claim = judge('knowledge/architecture.md#totally-made-up');
    expect(claim.verdict).toBe('unsupported');
    expect(claim.citation).toBeUndefined();
    expect(claim.unverified).toContain('no section "totally-made-up"');
  });

  it('calls a real section we did not retrieve unknown, and keeps the pointer', () => {
    // "auth" is a genuine heading of a doc we did retrieve — just not the part
    // we showed. Calling that a fabrication would be a lie about our own reach.
    const claim = judge('knowledge/architecture.md#auth');
    expect(claim.verdict).toBe('unknown');
    expect(claim.citation).toBe('knowledge/architecture.md#auth');
    expect(claim.unverified).toContain('not among the retrieved chunks');
  });

  it('calls a real but unretrieved doc unknown', () => {
    const claim = judge('knowledge/runbooks/deploy.md#rollback');
    expect(claim.verdict).toBe('unknown');
    expect(claim.citation).toBe('knowledge/runbooks/deploy.md#rollback');
    expect(claim.unverified).toContain('was not among the retrieved chunks');
  });

  it('names truncation as the reason when material was cut for budget', () => {
    const claim = judge('knowledge/runbooks/deploy.md', { ...coverage, truncatedCount: 12 });
    expect(claim.verdict).toBe('unknown');
    expect(claim.unverified).toContain('12 matching chunk(s) were cut');
  });

  it('calls a doc with no indexed content unknown, not unsupported', () => {
    // The coverage gap cgr's flow verdict is built around: the corpus holds
    // this doc, retrieval structurally cannot see it, so silence about it is
    // not evidence against it.
    const claim = judge('knowledge/glossary.md#widget');
    expect(claim.verdict).toBe('unknown');
    expect(claim.unverified).toContain('holds no indexed content');
  });

  it('keeps an unknown out of the citation count but inside the unverified count', () => {
    const out = normalizeSpecContent(
      draft({
        design: [
          { text: 'solid', citation: 'knowledge/architecture.md#contacts' },
          { text: 'shaky', citation: 'knowledge/architecture.md#auth' },
        ],
      }),
      withCoverage,
    );
    // An unchecked claim inflating the grounding metric is the metric lying.
    expect(countCitations(out)).toBe(1);
    expect(countUnverified(out)).toBe(1);
  });

  it('falls back to the retrieved-set check when no coverage was captured', () => {
    // Older runs and callers with no retrieval behind them still get the
    // binary answer rather than an accusation the checker cannot support.
    const claim = normalizeSpecContent(
      draft({ design: [{ text: 'x', citation: 'knowledge/architecture.md#auth' }] }),
      ctx,
    ).design[0]!;
    expect(claim.verdict).toBe('supported');
    expect(claim.citation).toBe('knowledge/architecture.md#auth');
  });
});
