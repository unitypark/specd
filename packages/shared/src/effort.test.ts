import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, STATION_EFFORT, effortFor, isEffort } from './effort.js';

describe('station defaults', () => {
  it('does not give every station the same level', () => {
    // The bug this replaced: `effort: 'high'` hardcoded at every call site,
    // which is simultaneously too little for a build and too much for an
    // index run. If these ever collapse to one value, that is back.
    expect(new Set(Object.values(STATION_EFFORT)).size).toBeGreaterThan(1);
  });

  it('spends most where code is written and least where text is summarized', () => {
    const rank = (level: string) => EFFORT_LEVELS.indexOf(level as never);
    expect(rank(STATION_EFFORT.build)).toBeGreaterThan(rank(STATION_EFFORT.spec));
    expect(rank(STATION_EFFORT.index)).toBeLessThan(rank(STATION_EFFORT.spec));
  });

  it('reviews as hard as it builds', () => {
    // Reading a diff for what is wrong with it is not the cheap half of the
    // job — a review run cheaply is a review nobody should act on.
    expect(STATION_EFFORT.review).toBe(STATION_EFFORT.build);
  });
});

describe('effortFor', () => {
  it('uses the station default when a project has no preference', () => {
    expect(effortFor('build')).toBe(STATION_EFFORT.build);
    expect(effortFor('index', null)).toBe(STATION_EFFORT.index);
  });

  it('lets an override move every station', () => {
    expect(effortFor('build', 'low')).toBe('low');
    expect(effortFor('index', 'max')).toBe('max');
  });

  it('treats null as absent, not as a level', () => {
    // The column is nullable and NULL means "no preference". Reading it as a
    // falsy level would silently move a project that never chose one.
    expect(effortFor('spec', null)).toBe(STATION_EFFORT.spec);
  });
});

describe('isEffort', () => {
  it('accepts every level the API and the CLI both take', () => {
    for (const level of EFFORT_LEVELS) expect(isEffort(level)).toBe(true);
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('rejects everything else, including the empty string the form sends', () => {
    expect(isEffort('')).toBe(false);
    expect(isEffort('highest')).toBe(false);
    expect(isEffort(null)).toBe(false);
    expect(isEffort(3)).toBe(false);
  });
});
