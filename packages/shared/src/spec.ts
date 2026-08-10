import type { SpecStatus } from './lifecycle.js';

/**
 * Spec anatomy (§7), unchanged from the proven design:
 *   Requirements — user stories with EARS acceptance criteria
 *   Design       — grounded in knowledge/ with per-claim citations
 *   Tasks        — ordered, each ≤ 1 PR, last one always files the as-built spec
 */

/** EARS: "WHEN <trigger> THE SYSTEM SHALL <response>". */
export const EARS_KEYWORDS = ['WHEN', 'WHILE', 'IF', 'WHERE'] as const;
export type EarsKeyword = (typeof EARS_KEYWORDS)[number];

export interface EarsCriterion {
  keyword: EarsKeyword;
  trigger: string;
  response: string;
}

export interface SpecRequirement {
  /** "As a <role>, I want <capability> so that <benefit>." */
  story: string;
  criteria: EarsCriterion[];
}

/**
 * A design claim carries its ground. `citation` points at a knowledge doc the
 * agent actually retrieved; when it couldn't ground the claim it must say so
 * rather than sound confident — the UNVERIFIED marker is load-bearing (§6).
 */
export interface DesignClaim {
  text: string;
  citation?: string;
  unverified?: string;
}

export interface SpecTask {
  id: string;
  title: string;
  size: 'S' | 'M' | 'L';
  repo?: string;
  done?: boolean;
  /** The final task of every spec files the as-built copy (rule 7). */
  asBuilt?: boolean;
}

export interface SpecContent {
  requirements: SpecRequirement[];
  design: DesignClaim[];
  tasks: SpecTask[];
  outOfScope?: string[];
  openQuestions?: string[];
}

export interface SpecVersionSummary {
  id: string;
  version: number;
  status: SpecStatus;
  citationCount: number;
  unverifiedCount: number;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt: string;
}

export function countCitations(content: SpecContent): number {
  return content.design.filter((c) => c.citation).length;
}

export function countUnverified(content: SpecContent): number {
  return content.design.filter((c) => c.unverified).length;
}

/** Branch name a coding agent must use (AGENTS.md rule 6). */
export function specBranchName(ticketKey: string, slug: string): string {
  return `spec/${ticketKey.toLowerCase()}-${slug}`;
}

/** Where the as-built spec lands in the primary repo (D8). */
export function asBuiltPath(ticketKey: string, slug: string): string {
  return `knowledge/specs/${ticketKey.toUpperCase()}-${slug}.md`;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Renders a spec as the plain markdown `specd spec pull` hands to any agent. */
/**
 * The as-built record filed into `knowledge/specs/` when a spec is built.
 *
 * It lives here, not beside the build agent, because two different processes
 * write it: the in-process build station and the `@specd/runner` daemon on a
 * paired machine (`knowledge/decisions/0009-...`). Both must produce the same
 * bytes for the same spec, and the only way to guarantee that is one function.
 *
 * A model never writes this file. It is a verbatim record of what a human
 * approved, so asking a model to reproduce it would invite drift in the one
 * document that has to be exact — a runner executing this function is still
 * specd writing the file, not the model.
 */
export function renderAsBuiltMarkdown(
  spec: {
    ticketKey: string;
    title: string;
    version: number;
    status: SpecStatus;
    approvedBy?: string | null;
    approvedAt?: string | null;
    content: SpecContent;
  },
  verify: { passed: boolean | null; command: string | null },
): string {
  const header = [
    `<!-- Filed automatically by specd when ${spec.ticketKey} was built. -->`,
    '<!-- This is a historical record: never rewrite it. If reality later -->',
    '<!-- diverged, append a "## Deviations" section below.              -->',
    '',
  ].join('\n');

  // "passed", "failed" and "never ran" are three different things to whoever
  // reads this later. Collapsing the third into either of the others would
  // make the record claim something nobody checked.
  const verification = verify.command
    ? `\n## Verification\n\n\`${verify.command}\` — ${
        verify.passed === null ? 'not run' : verify.passed ? 'passed' : '**failed** at build time'
      }\n`
    : '\n## Verification\n\nNo verify command was detected for this repository.\n';

  return header + renderSpecMarkdown(spec) + verification;
}

export function renderSpecMarkdown(input: {
  ticketKey: string;
  title: string;
  version: number;
  status: SpecStatus;
  approvedBy?: string | null;
  approvedAt?: string | null;
  content: SpecContent;
}): string {
  const { ticketKey, title, version, status, approvedBy, approvedAt, content } = input;
  const lines: string[] = [];

  lines.push(`# ${ticketKey} — ${title}`);
  lines.push('');
  lines.push(`> spec v${version} · status: ${status}`);
  if (approvedBy) {
    lines.push(`> approved by ${approvedBy}${approvedAt ? ` on ${approvedAt}` : ''}`);
  }
  lines.push('');

  lines.push('## Requirements');
  lines.push('');
  for (const req of content.requirements) {
    lines.push(`### ${req.story}`);
    lines.push('');
    for (const c of req.criteria) {
      lines.push(`- **${c.keyword}** ${c.trigger} **THE SYSTEM SHALL** ${c.response}`);
    }
    lines.push('');
  }

  lines.push('## Design');
  lines.push('');
  for (const claim of content.design) {
    const suffix = claim.citation
      ? ` _(per ${claim.citation})_`
      : claim.unverified
        ? ` _(**UNVERIFIED** — ${claim.unverified})_`
        : '';
    lines.push(`- ${claim.text}${suffix}`);
  }
  lines.push('');

  if (content.outOfScope?.length) {
    lines.push('### Out of scope');
    lines.push('');
    for (const item of content.outOfScope) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Tasks');
  lines.push('');
  for (const task of content.tasks) {
    const box = task.done ? '[x]' : '[ ]';
    const meta = [task.size, task.repo].filter(Boolean).join(' · ');
    lines.push(`- ${box} **${task.id}** ${task.title}${meta ? ` — _${meta}_` : ''}`);
  }
  lines.push('');

  if (content.openQuestions?.length) {
    lines.push('## Open questions');
    lines.push('');
    for (const q of content.openQuestions) lines.push(`- ${q}`);
    lines.push('');
  }

  return lines.join('\n');
}
