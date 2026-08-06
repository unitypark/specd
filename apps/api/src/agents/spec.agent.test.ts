import { describe, expect, it } from 'vitest';
import type { RetrievedChunk, SpecContent } from '@specd/shared';
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
