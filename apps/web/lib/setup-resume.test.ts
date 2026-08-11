import { describe, expect, it } from 'vitest';
import { deriveResumeStep } from './setup-resume';

const vcs = { kind: 'vcs', provider: 'local' };
const ai = { kind: 'ai', provider: 'anthropic' };
const tracker = { kind: 'tracker', provider: 'board' };

describe('deriveResumeStep', () => {
  it('an untouched draft resumes at Connect code', () => {
    expect(deriveResumeStep([])).toBe(2);
  });

  it('each persisted connection advances the resume point', () => {
    expect(deriveResumeStep([vcs])).toBe(3);
    expect(deriveResumeStep([vcs, ai])).toBe(4);
    expect(deriveResumeStep([vcs, ai, tracker])).toBe(5);
  });

  it('order does not matter — the server returns connections unordered', () => {
    expect(deriveResumeStep([tracker, ai, vcs])).toBe(5);
    expect(deriveResumeStep([ai, vcs])).toBe(4);
  });

  it('a gap resumes at the gap, not after the latest connection', () => {
    // tracker exists but ai does not — someone connected out of order or a
    // connect call failed silently; resume where the first hole is.
    expect(deriveResumeStep([vcs, tracker])).toBe(3);
  });
});
