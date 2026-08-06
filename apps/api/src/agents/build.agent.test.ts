import { describe, expect, it } from 'vitest';
import { looksUnrunnable } from './build.agent.js';

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
