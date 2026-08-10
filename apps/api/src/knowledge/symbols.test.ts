import { describe, expect, it } from 'vitest';
import { extractSymbols, specForPath } from './symbols.js';

const q = (syms: { qualifiedName: string }[]) => syms.map((s) => s.qualifiedName);

describe('specForPath', () => {
  it('recognises the languages it has rules for', () => {
    expect(specForPath('a/b.ts')).toBeTruthy();
    expect(specForPath('a/b.go')).toBeTruthy();
    expect(specForPath('a/b.py')).toBeTruthy();
  });

  it('declines everything else rather than guessing', () => {
    // A tier that pretends to understand every extension produces confident
    // nonsense; declining is the honest output.
    expect(specForPath('a/b.rs')).toBeNull();
    expect(specForPath('README')).toBeNull();
  });
});

describe('extractSymbols — TypeScript', () => {
  const src = [
    '/**',
    ' * class NotReal — a doc comment, not a declaration.',
    ' */',
    'export class RunnerJobsService {',
    '  private readonly logger = 1;',
    '  async claim(runner: Runner) {',
    '    if (x) {',
    '      return this.report();',
    '    }',
    '  }',
    '  report(): void {}',
    '  #secret() {}',
    '}',
    '',
    'export function slugify(s: string) {}',
    'function internal() {}',
    'export interface ClaimedJob {}',
    'export type JobReport = A | B;',
    'export const LIMIT = 5;',
    '// export class Commented {}',
  ].join('\n');
  const syms = extractSymbols('apps/api/src/x.ts', src);

  it('finds declarations with their qualified names', () => {
    expect(q(syms)).toContain('RunnerJobsService');
    expect(q(syms)).toContain('RunnerJobsService.claim');
    expect(q(syms)).toContain('RunnerJobsService.report');
    expect(q(syms)).toContain('slugify');
    expect(q(syms)).toContain('ClaimedJob');
    expect(q(syms)).toContain('JobReport');
    expect(q(syms)).toContain('LIMIT');
  });

  it('does not mistake control flow inside a body for a member', () => {
    // The failure a looser member rule always has: `if (`, `return (`.
    expect(q(syms)).not.toContain('RunnerJobsService.if');
    expect(q(syms)).not.toContain('RunnerJobsService.return');
  });

  it('ignores declarations that only appear in comments', () => {
    expect(q(syms)).not.toContain('NotReal');
    expect(q(syms)).not.toContain('Commented');
  });

  it('records where each one is, and whether it is exported', () => {
    const claim = syms.find((s) => s.qualifiedName === 'RunnerJobsService.claim');
    expect(claim?.line).toBe(6);
    expect(syms.find((s) => s.name === 'slugify')?.exported).toBe(true);
    expect(syms.find((s) => s.name === 'internal')?.exported).toBe(false);
    expect(syms.find((s) => s.name === '#secret')).toBeUndefined();
  });
});

describe('extractSymbols — Go', () => {
  const syms = extractSymbols(
    'cli/cmd/specd/main.go',
    [
      'package main',
      '',
      'type Client struct {',
      '  Token string',
      '}',
      '',
      'func (c *Client) Do(path string) error {',
      '  return nil',
      '}',
      '',
      'func main() {}',
      'func helper() {}',
    ].join('\n'),
  );

  it('reads a receiver method as Type.Method', () => {
    // Go states the parent in the declaration itself, so it needs no scope
    // tracking — unlike the indentation-anchored languages.
    expect(q(syms)).toContain('Client.Do');
    expect(q(syms)).toContain('Client');
    expect(q(syms)).toContain('main');
  });

  it('uses Go\'s own export rule rather than a keyword', () => {
    expect(syms.find((s) => s.name === 'Do')?.exported).toBe(true);
    expect(syms.find((s) => s.name === 'helper')?.exported).toBe(false);
  });
});

describe('extractSymbols — Go grouped declarations', () => {
  // Found by the Go oracle: `const (…)` is how Go declares related constants,
  // and every member is a top-level declaration with no keyword of its own,
  // so a per-line keyword rule saw none of them. Seventeen missing in this
  // repository's own CLI.
  const syms = extractSymbols(
    'cli/cmd/specd/main.go',
    [
      'package main',
      '',
      'const (',
      '\texitOK = 0',
      '\texitError = 1',
      '\t_ = 2',
      ')',
      '',
      'var (',
      '\tbannerStyle = lipgloss.NewStyle().',
      '\t\tBorder(lipgloss.RoundedBorder()).',
      '\t\tPadding(0, 1)',
      '\tplain, dim = 1, 2',
      ')',
      '',
      'func main() {}',
    ].join('\n'),
  );

  it('finds every member of a grouped declaration', () => {
    expect(q(syms)).toEqual(expect.arrayContaining(['exitOK', 'exitError', 'bannerStyle', 'main']));
  });

  it('reads a comma-separated member as two declarations', () => {
    expect(q(syms)).toEqual(expect.arrayContaining(['plain', 'dim']));
  });

  it('does not mistake a wrapped method chain for a declaration', () => {
    // `Border(` starts a line inside the group and is shaped exactly like a
    // member; what tells them apart is the `(` that follows.
    expect(q(syms)).not.toContain('Border');
    expect(q(syms)).not.toContain('Padding');
  });

  it('skips the blank identifier', () => {
    expect(q(syms)).not.toContain('_');
  });

  it('closes the group at the closing paren', () => {
    // `main` is declared after `)`, so finding it proves the group ended.
    expect(syms.find((s) => s.name === 'main')?.kind).toBe('function');
  });
});

describe('extractSymbols — Python', () => {
  const syms = extractSymbols(
    'svc/app.py',
    ['class Service:', '    def handle(self):', '        pass', '', 'def top():', '    pass'].join('\n'),
  );

  it('attributes an indented def to the class above it', () => {
    expect(q(syms)).toEqual(expect.arrayContaining(['Service', 'Service.handle', 'top']));
  });
});

describe('extractSymbols — unknown languages', () => {
  it('returns nothing rather than guessing', () => {
    expect(extractSymbols('main.rs', 'pub fn main() {}')).toEqual([]);
  });
});
