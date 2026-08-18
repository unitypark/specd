import { describe, expect, it } from 'vitest';
import type { SpecView } from '@specd/shared';
import { buildPrBody, looksUnrunnable } from './build.agent.js';

/**
 * "Your tests failed" and "I could not run your tests" are different signals.
 * Conflating them makes a perfectly good branch look broken because a
 * toolchain was missing — so the distinction is tested rather than assumed.
 */
describe('verify outcome classification', () => {
  it('recognises a missing binary', () => {
    expect(looksUnrunnable('sh: eslint: command not found')).toBe(true);
    expect(looksUnrunnable('/bin/sh: 1: vitest: not found')).toBe(true);
  });

  it('recognises uninstalled dependencies', () => {
    expect(
      looksUnrunnable('WARN  Local package.json exists, but node_modules missing'),
    ).toBe(true);
    expect(looksUnrunnable("Error: Cannot find module '@nestjs/core'")).toBe(true);
    expect(looksUnrunnable('ENOENT: no such file or directory, open ...')).toBe(true);
  });

  it('treats a genuine test failure as a real failure', () => {
    const output = `
 FAIL  src/contacts/csv.test.ts > escapes embedded commas
   AssertionError: expected 'a,b' to be '"a,b"'
 Tests  1 failed | 12 passed (13)
`;
    expect(looksUnrunnable(output)).toBe(false);
  });

  it('treats a compile error as a real failure', () => {
    const output = "src/contacts/contacts.service.ts(41,3): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(looksUnrunnable(output)).toBe(false);
  });

  it('treats a lint failure as a real failure', () => {
    expect(looksUnrunnable('src/a.ts\n  3:1  error  Unexpected console statement  no-console')).toBe(
      false,
    );
  });

  it('does not fire on empty output', () => {
    expect(looksUnrunnable('')).toBe(false);
  });
});

describe('the PR body when evidence moved', () => {
  const spec = {
    ticketKey: 'CRM-1',
    title: 'Add a widget',
    version: 2,
    status: 'building',
    approvedBy: 'Theo',
    approvedAt: '2026-08-01T00:00:00.000Z',
    content: {
      requirements: [],
      design: [],
      tasks: [],
      outOfScope: [],
      openQuestions: [],
    },
  } as unknown as Parameters<typeof buildPrBody>[0];

  it('says nothing when every citation still stands', () => {
    const body = buildPrBody(spec, {
      commits: 3,
      verifyPassed: true,
      verifyCommand: 'pnpm test',
      asBuilt: 'knowledge/specs/CRM-1-add-widget.md',
      drifted: [],
    });
    expect(body).not.toContain('no longer stand');
  });

  it('names drifted citations where the reviewer is, not only in the run log', () => {
    // The person merging is the last one who can notice that the spec was
    // approved against evidence which has since changed.
    const body = buildPrBody(spec, {
      commits: 3,
      verifyPassed: true,
      verifyCommand: 'pnpm test',
      asBuilt: 'knowledge/specs/CRM-1-add-widget.md',
      drifted: [
        {
          claim: 'Auth is JWT.',
          citation: 'knowledge/architecture.md#auth',
          was: 'supported',
          now: 'unsupported',
          note: 'no such section',
        },
      ],
    });
    expect(body).toContain('1 citation(s) no longer stand');
    expect(body).toContain('knowledge/architecture.md#auth');
    expect(body).toContain('was `supported`, now `unsupported`');
    // Advisory, and it says so — otherwise a reader assumes the build was
    // gated on this and that somebody already decided it was fine.
    expect(body).toContain('did not');
  });
});


describe('the review section of a pull request body', () => {
  const spec = {
    ticketKey: 'E-101',
    title: 'Add CSV export',
    version: 2,
    approvedBy: 'jpark',
    approvedAt: '2026-08-18T00:00:00.000Z',
    content: { requirements: [], design: [], tasks: [] },
  } as unknown as SpecView;

  const base = { commits: 3, verifyPassed: true, verifyCommand: 'pnpm test', asBuilt: 'k/s/E-101.md' };

  it('says nothing at all when the pass could not run', () => {
    // An absent review must read as absent. A "no findings" banner for a pass
    // that never happened is the same lie as a green verify for tests that
    // never ran.
    expect(buildPrBody(spec, base)).not.toMatch(/Review pass/);
    expect(buildPrBody(spec, { ...base, review: null })).not.toMatch(/Review pass/);
    expect(
      buildPrBody(spec, { ...base, review: { verdict: 'unreviewed', findings: [] } }),
    ).not.toMatch(/Review pass/);
  });

  it('reports a clean pass, because silence would be indistinguishable from not running', () => {
    const body = buildPrBody(spec, {
      ...base,
      review: { verdict: 'clean', summary: 'Does what the spec approved.', findings: [] },
    });
    expect(body).toMatch(/found nothing to raise/);
    expect(body).toContain('Does what the spec approved.');
  });

  it('leads with blocking findings and says they did not block', () => {
    const body = buildPrBody(spec, {
      ...base,
      review: {
        verdict: 'findings',
        summary: 'Exports, but drops a column.',
        findings: [
          { where: 'src/a.ts:12', severity: 'nit', what: 'Stray import.' },
          { where: 'src/b.ts:40', severity: 'blocking', what: 'Header row omitted.', against: 'SHALL include a header' },
          { where: 'src/c.ts:7', severity: 'consider', what: 'Could stream instead.' },
        ],
      },
    });

    // Ordered by severity: a reviewer scanning the top of the list must hit
    // the blocking one first, whatever order the model emitted them in.
    expect(body.indexOf('src/b.ts:40')).toBeLessThan(body.indexOf('src/c.ts:7'));
    expect(body.indexOf('src/c.ts:7')).toBeLessThan(body.indexOf('src/a.ts:12'));

    expect(body).toMatch(/3 finding\(s\), 1 of them blocking/);
    expect(body).toMatch(/advisory — they did not stop the build/);
    expect(body).toContain('SHALL include a header');
  });

  it('keeps the acceptance criteria below the findings', () => {
    // The findings are the new reading; the criteria are what the reader
    // checks them against. Reversing that buries the part nobody has seen.
    const body = buildPrBody(spec, {
      ...base,
      review: { verdict: 'findings', summary: 's', findings: [{ where: 'a:1', severity: 'nit', what: 'x' }] },
    });
    expect(body.indexOf('### Review pass')).toBeLessThan(body.indexOf('### Acceptance criteria'));
  });
});
