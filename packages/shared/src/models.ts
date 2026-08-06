/**
 * Model allowlist and pricing. `AgentRun.cost_eur` is metered from these rates
 * (§10), and the per-project spend cap is enforced against the total before
 * every run (§12).
 *
 * Rates are Anthropic first-party USD per million tokens.
 */
export const MODELS = {
  'claude-opus-5': {
    label: 'Claude Opus 5',
    inputUsdPerMTok: 5.0,
    outputUsdPerMTok: 25.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    contextWindow: 1_000_000,
    note: 'deepest specs — the default',
  },
  'claude-sonnet-5': {
    label: 'Claude Sonnet 5',
    inputUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    contextWindow: 1_000_000,
    note: 'balanced speed and cost',
  },
  'claude-haiku-4-5': {
    label: 'Claude Haiku 4.5',
    inputUsdPerMTok: 1.0,
    outputUsdPerMTok: 5.0,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    contextWindow: 200_000,
    note: 'drafts & indexing',
  },
} as const;

export type ModelId = keyof typeof MODELS;

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export const DEFAULT_MODEL: ModelId = 'claude-opus-5';

export function isModelId(value: string): value is ModelId {
  return value in MODELS;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Cost of one model call, in EUR cents (integer — money never lives in a
 * float). Cached input is billed at its own multiplier so the meter matches
 * the invoice rather than approximating it.
 */
export function costEurCents(model: ModelId, usage: TokenUsage, usdToEur: number): number {
  const rate = MODELS[model];
  const perToken = (usdPerMTok: number) => usdPerMTok / 1_000_000;

  const usd =
    usage.inputTokens * perToken(rate.inputUsdPerMTok) +
    usage.outputTokens * perToken(rate.outputUsdPerMTok) +
    (usage.cacheCreationInputTokens ?? 0) *
      perToken(rate.inputUsdPerMTok) *
      rate.cacheWriteMultiplier +
    (usage.cacheReadInputTokens ?? 0) * perToken(rate.inputUsdPerMTok) * rate.cacheReadMultiplier;

  return Math.round(usd * usdToEur * 100);
}

export function formatEurCents(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}
