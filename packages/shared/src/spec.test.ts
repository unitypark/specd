import { describe, expect, it } from 'vitest';
import {
  asBuiltPath,
  countCitations,
  countUnverified,
  outcomeOf,
  renderAsBuiltMarkdown,
  renderSpecMarkdown,
  slugify,
  specBranchName,
  type SpecContent,
} from './spec.js';

const content: SpecContent = {
  requirements: [
    {
      story: 'As a sales-ops user, I can export the filtered contact list to CSV.',
      criteria: [
        {
          keyword: 'WHEN',
          trigger: 'a user triggers export on a filtered list',
          response: 'stream a CSV honouring the active filters and column selection',
        },
        {
          keyword: 'WHILE',
          trigger: 'a user lacks the export permission',
          response: 'hide the action and reject the endpoint with 403',
        },
      ],
    },
  ],
  design: [
    { text: 'Reuse the list-query builder', citation: 'knowledge/architecture.md#contacts' },
    { text: 'Async path via the outbox worker', citation: 'knowledge/architecture.md#events' },
    { text: 'Retention is 24 hours', unverified: 'confirm with sales ops' },
  ],
  tasks: [
    { id: 'T1', title: 'streaming CSV endpoint', size: 'M', repo: 'aurora-api' },
    {
      id: 'T2',
      title: 'commit as-built spec → knowledge/specs/CRM-142-export-contacts.md',
      size: 'S',
      asBuilt: true,
    },
  ],
  outOfScope: ['XLSX export'],
  openQuestions: ['Which columns are default?'],
};

describe('spec content', () => {
  it('counts citations and unverified claims separately', () => {
    expect(countCitations(content)).toBe(2);
    expect(countUnverified(content)).toBe(1);
  });

  it('renders EARS criteria in the form a coding agent can test against', () => {
    const md = renderSpecMarkdown({
      ticketKey: 'CRM-142',
      title: 'Export contacts to CSV',
      version: 2,
      status: 'approved',
      approvedBy: 'Dana K.',
      approvedAt: '2026-08-05',
      content,
    });

    expect(md).toContain('# CRM-142 — Export contacts to CSV');
    expect(md).toContain('spec v2 · status: approved');
    expect(md).toContain('approved by Dana K. on 2026-08-05');
    expect(md).toContain('**WHEN** a user triggers export on a filtered list **THE SYSTEM SHALL**');
    expect(md).toContain('**WHILE** a user lacks the export permission **THE SYSTEM SHALL**');
  });

  it('renders citations and UNVERIFIED markers distinguishably', () => {
    const md = renderSpecMarkdown({
      ticketKey: 'CRM-142',
      title: 'Export contacts to CSV',
      version: 1,
      status: 'draft',
      content,
    });
    expect(md).toContain('_(per knowledge/architecture.md#contacts)_');
    expect(md).toContain('_(**UNVERIFIED** — confirm with sales ops)_');
  });

  it('does not claim an approver when there is none', () => {
    const md = renderSpecMarkdown({
      ticketKey: 'CRM-142',
      title: 'x',
      version: 1,
      status: 'draft',
      content,
    });
    expect(md).not.toContain('approved by');
  });

  it('derives branch and as-built paths the working agreements require', () => {
    expect(slugify('Export contacts to CSV')).toBe('export-contacts-to-csv');
    expect(specBranchName('CRM-142', 'export-contacts-to-csv')).toBe(
      'spec/crm-142-export-contacts-to-csv',
    );
    expect(asBuiltPath('crm-142', 'export-contacts-to-csv')).toBe(
      'knowledge/specs/CRM-142-export-contacts-to-csv.md',
    );
  });

  it('produces safe slugs from awkward titles', () => {
    expect(slugify('  Fix: the "widget" (v2) — again!  ')).toBe('fix-the-widget-v2-again');
    expect(slugify('///')).toBe('');
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(48);
  });

  describe('renderAsBuiltMarkdown', () => {
    const spec = {
      ticketKey: 'CRM-142',
      title: 'Export contacts to CSV',
      version: 2,
      status: 'approved' as const,
      approvedBy: 'Theo',
      approvedAt: '2026-08-10T09:00:00.000Z',
      content,
    };

    it('marks the record as history that must not be rewritten', () => {
      const md = renderAsBuiltMarkdown(spec, { passed: true, command: 'pnpm test' });
      expect(md).toContain('Filed automatically by specd when CRM-142 was built');
      expect(md).toContain('never rewrite it');
      expect(md).toContain('## Deviations');
      // The approval it records is the whole point of the file.
      expect(md).toContain('approved by Theo');
    });

    it('keeps "passed", "failed" and "never ran" three different statements', () => {
      const passed = renderAsBuiltMarkdown(spec, { passed: true, command: 'pnpm test' });
      const failed = renderAsBuiltMarkdown(spec, { passed: false, command: 'pnpm test' });
      const unrun = renderAsBuiltMarkdown(spec, { passed: null, command: 'pnpm test' });
      const none = renderAsBuiltMarkdown(spec, { passed: null, command: null });

      expect(passed).toContain('`pnpm test` — passed');
      expect(failed).toContain('**failed** at build time');
      // "Could not run" must never read as a pass — a reviewer told "passed"
      // when nothing ran has been misled.
      expect(unrun).toContain('`pnpm test` — not run');
      expect(unrun).not.toContain('passed');
      expect(none).toContain('No verify command was detected');
    });

    it('is byte-identical for the same input, so both build paths file the same file', () => {
      // The in-process build station and the @specd/runner daemon call this
      // same function on different machines (decision 0009). If they ever
      // diverged, the as-built record would depend on where it was built.
      const a = renderAsBuiltMarkdown(spec, { passed: false, command: 'make check' });
      const b = renderAsBuiltMarkdown({ ...spec }, { passed: false, command: 'make check' });
      expect(a).toBe(b);
      expect(a).toContain(renderSpecMarkdown(spec));
    });
  });
});

describe('reading an as-built record', () => {
  const record = (verify: { passed: boolean | null; command: string | null }) =>
    renderAsBuiltMarkdown(
      {
        ticketKey: 'CRM-1',
        title: 'Add a widget',
        version: 2,
        status: 'delivered',
        approvedBy: 'Theo',
        approvedAt: '2026-08-01T00:00:00.000Z',
        content: {
          requirements: [],
          design: [],
          tasks: [],
          outOfScope: [],
          openQuestions: [],
        },
      },
      verify,
    );

  // The parser reads what the renderer writes, so it is tested against the
  // renderer's real output rather than a hand-typed approximation — a
  // template that gains a blank line should fail this, not ship past it.
  it('reads back each of the three verification outcomes', () => {
    expect(outcomeOf(record({ passed: true, command: 'pnpm test' })).verification).toBe(
      '`pnpm test` — passed',
    );
    expect(outcomeOf(record({ passed: false, command: 'pnpm test' })).verification).toBe(
      '`pnpm test` — **failed** at build time',
    );
    // The one a boolean would lose. "Nobody ran it" is not "it failed", and
    // it is not "it passed" either.
    expect(outcomeOf(record({ passed: null, command: 'pnpm test' })).verification).toBe(
      '`pnpm test` — not run',
    );
  });

  it('reads a repo with no verify command as such', () => {
    expect(outcomeOf(record({ passed: null, command: null })).verification).toBe(
      'No verify command was detected for this repository.',
    );
  });

  it('notices a Deviations section without summarising it', () => {
    const clean = record({ passed: true, command: 'pnpm test' });
    expect(outcomeOf(clean).hasDeviations).toBe(false);

    const diverged = `${clean}\n## Deviations\n\nTask 3 ran on the merge poll instead.\n`;
    const read = outcomeOf(diverged);
    expect(read.hasDeviations).toBe(true);
    // Still reports the verification: a record that diverged is not a record
    // that went unverified.
    expect(read.verification).toBe('`pnpm test` — passed');
  });

  it('says nothing rather than guessing when the section is absent', () => {
    expect(outcomeOf('# Just a doc\n\nSome prose.\n')).toEqual({
      verification: null,
      hasDeviations: false,
    });
  });

  it('does not mistake a mention of deviations for the section itself', () => {
    const prose = '# ADR\n\nWe considered deviations from the plan but did not take any.\n';
    expect(outcomeOf(prose).hasDeviations).toBe(false);
  });
});

describe('reading an as-built record that was written by hand', () => {
  // Found in review. Each of these produced a wrong answer, and each is a
  // shape a human-written or hand-appended record actually takes.
  it('does not report the next heading as the verify outcome', () => {
    const empty = '# S-9\n\n## Verification\n\n## Deviations\n\nWe skipped it.\n';
    expect(outcomeOf(empty)).toEqual({ verification: null, hasDeviations: true });
  });

  it('reads a record that opens with the heading', () => {
    // `index === 0` is a position, not an absence.
    expect(outcomeOf('## Verification\n\n`pnpm test` — passed\n').verification).toBe(
      '`pnpm test` — passed',
    );
  });

  it('does not mistake a documented example for project history', () => {
    // specd's own knowledge base documents this format inside fences; scanning
    // raw text reports the documentation as a spec that diverged.
    const doc = ['# How to file an as-built', '', '```markdown', '## Deviations', '',
      'Task 3 ran on the merge poll.', '```', ''].join('\n');
    expect(outcomeOf(doc).hasDeviations).toBe(false);
  });
});
