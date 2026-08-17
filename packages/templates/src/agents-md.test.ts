import { describe, expect, it } from 'vitest';
import {
  SPECD_BLOCK_BEGIN,
  SPECD_BLOCK_END,
  mergeAgentsMd,
  mergeClaudeMd,
  renderAgentsMd,
  renderClaudeMd,
} from './agents-md.js';

const generated = renderAgentsMd({
  repoName: 'acme/api',
  stack: {
    language: 'TypeScript',
    packageManager: 'pnpm',
    testRunner: 'Vitest',
    verifyCommand: 'pnpm test',
    extras: [],
  },
  isPrimary: true,
  projectName: 'Acme',
});

/** A team's own file, of the kind onboarding must never overwrite. */
const theirs = `# AGENTS.md

## House rules
- Never touch \`legacy/\` without asking Priya.
- Every migration needs a rollback in the same PR.
`;

describe('mergeAgentsMd', () => {
  it('writes the generated file as-is when the repo has none', () => {
    expect(mergeAgentsMd(null, generated)).toBe(generated);
    expect(mergeAgentsMd('   \n', generated)).toBe(generated);
  });

  it('keeps every line of an existing file and appends the specd block', () => {
    const merged = mergeAgentsMd(theirs, generated);

    for (const line of theirs.trim().split('\n')) {
      expect(merged).toContain(line);
    }
    expect(merged).toContain(SPECD_BLOCK_BEGIN);
    expect(merged).toContain(SPECD_BLOCK_END);
    expect(merged.indexOf('Never touch')).toBeLessThan(merged.indexOf(SPECD_BLOCK_BEGIN));
    expect(merged).toContain('Before implementing ANYTHING');
  });

  it('leaves the team the only H1 — the appended block is a section, not a rival document', () => {
    const merged = mergeAgentsMd(theirs, generated);
    expect(merged.match(/^# /gm)).toHaveLength(1);
  });

  it('marks whose rules are whose in text a renderer will actually show', () => {
    // The fence is an HTML comment, and every markdown renderer hides those —
    // so on the pull request page a reader would see one continuous list of
    // rules with no idea which half arrived this morning.
    const merged = mergeAgentsMd(theirs, generated);
    expect(merged).toContain('## Working agreements added by specd');
    expect(merged).toContain('Your own rules above came');
  });

  it('replaces its own block on a re-run instead of stacking a second copy', () => {
    const first = mergeAgentsMd(theirs, generated);
    const second = mergeAgentsMd(first, generated.replace('Stack:', 'Stack (rescanned):'));

    expect(second.match(new RegExp(SPECD_BLOCK_BEGIN.slice(0, 20), 'g'))).toHaveLength(1);
    expect(second).toContain('Stack (rescanned):');
    expect(second).toContain('Never touch `legacy/` without asking Priya.');
  });

  it('survives a half-deleted fence rather than appending underneath it', () => {
    const damaged = `${theirs}\n${SPECD_BLOCK_BEGIN}\n\nold rules someone cut the end off\n`;
    const merged = mergeAgentsMd(damaged, generated);

    expect(merged).not.toContain('old rules someone cut the end off');
    expect(merged).toContain('Never touch `legacy/` without asking Priya.');
    expect(merged).toContain(SPECD_BLOCK_END);
  });

  it('replaces a file specd itself generated before markers existed', () => {
    // Nobody's writing is discarded here, so there is nothing to preserve —
    // and fencing specd's own output inside specd's own output reads as two
    // sets of rules where there is one.
    const merged = mergeAgentsMd(generated, generated);
    expect(merged).toBe(generated);
    expect(merged).not.toContain(SPECD_BLOCK_BEGIN);
  });
});

describe('mergeClaudeMd', () => {
  it('writes the pointer when the repo has no CLAUDE.md', () => {
    expect(mergeClaudeMd(null)).toBe(renderClaudeMd());
  });

  it('does nothing at all when the existing file already imports AGENTS.md', () => {
    // null is "leave this path out of the PR" — an identical file in a diff is
    // a reviewer's wasted minute.
    expect(mergeClaudeMd(renderClaudeMd())).toBeNull();
    expect(mergeClaudeMd('# Ours\n\n@AGENTS.md\n\nplus our own notes\n')).toBeNull();
  });

  it('adds the import above an existing file without touching its content', () => {
    const merged = mergeClaudeMd('# Our Claude notes\n\nRun the seed script first.\n');

    expect(merged).toContain('Run the seed script first.');
    expect(merged?.split('\n')[0]).toBe('@AGENTS.md');
  });

  it('does not mistake a mention inside prose for the import', () => {
    // Claude Code follows `@AGENTS.md` only on a line of its own, so a
    // sentence about the file is not the same as importing it.
    expect(mergeClaudeMd('See @AGENTS.md for the rules.\n')).toContain('@AGENTS.md\n\nSee');
  });
});
