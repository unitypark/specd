import { describe, expect, it } from 'vitest';
import {
  asBuiltPath,
  countCitations,
  countUnverified,
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
