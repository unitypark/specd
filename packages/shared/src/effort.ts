/**
 * How hard a model works on one call.
 *
 * `effort` is the intelligence ↔ latency ↔ cost dial (`output_config.effort`
 * on the API, `--effort` on the Claude Code CLI). It was typed here from the
 * start and then hardcoded to `high` at every call site, which left the two
 * stations that want opposite settings sharing one — a build wants the model
 * thinking hard about code it is about to commit, and an index run wants the
 * cheapest pass that still parses.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The stations that call a model. Indexing is here because it is the cheap one. */
export type EffortStation = 'ground' | 'spec' | 'build' | 'review' | 'index';

/**
 * What each station gets when a project has expressed no preference.
 *
 * These are not one value repeated. Anthropic's own guidance is that `xhigh`
 * is the setting for coding and agentic work — it is what Claude Code itself
 * runs at — while cheap mechanical passes are the place to spend `low`. specd
 * ran every station at `high`, which was simultaneously too little for the
 * build station and too much for indexing.
 */
export const STATION_EFFORT: Record<EffortStation, Effort> = {
  // Writes code that a human is about to review and merge.
  build: 'xhigh',
  // Reads a diff it did not write, looking for what is wrong with it.
  review: 'xhigh',
  // Judgement over retrieved evidence, but a single structured answer.
  spec: 'high',
  ground: 'high',
  // Summarising and embedding. Cheapest pass that still parses.
  index: 'low',
};

/**
 * The effort one station runs at, given a project's override.
 *
 * A project override applies to every station rather than replacing the
 * per-station shape: someone who sets it is expressing "this project is
 * cost-sensitive" or "this project is worth the spend", not re-deciding the
 * relative cost of grounding versus building.
 */
export function effortFor(station: EffortStation, override?: Effort | null): Effort {
  return override ?? STATION_EFFORT[station];
}
