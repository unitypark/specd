import { describe, expect, it } from 'vitest';
import { MODELS, costEurCents, formatEurCents, isModelId } from './models.js';

describe('cost metering', () => {
  const usdToEur = 0.92;

  it('prices a plain call from the model rate card', () => {
    // 1M input + 1M output on Opus 5 = $5 + $25 = $30 → €27.60
    const cents = costEurCents(
      'claude-opus-5',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      usdToEur,
    );
    expect(cents).toBe(2760);
    expect(formatEurCents(cents)).toBe('€27.60');
  });

  it('bills cached input at its own multipliers, not the full rate', () => {
    const full = costEurCents(
      'claude-opus-5',
      { inputTokens: 1_000_000, outputTokens: 0 },
      usdToEur,
    );
    const cachedRead = costEurCents(
      'claude-opus-5',
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      usdToEur,
    );
    const cachedWrite = costEurCents(
      'claude-opus-5',
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      usdToEur,
    );

    // A cache read is ~0.1x of full price; a write is ~1.25x.
    expect(cachedRead).toBe(Math.round(full * 0.1));
    expect(cachedWrite).toBe(Math.round(full * 1.25));
  });

  it('is cheaper on smaller models', () => {
    const usage = { inputTokens: 500_000, outputTokens: 200_000 };
    const opus = costEurCents('claude-opus-5', usage, usdToEur);
    const sonnet = costEurCents('claude-sonnet-5', usage, usdToEur);
    const haiku = costEurCents('claude-haiku-4-5', usage, usdToEur);
    expect(opus).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(haiku);
  });

  it('returns whole cents so spend never accumulates float drift', () => {
    const cents = costEurCents(
      'claude-haiku-4-5',
      { inputTokens: 1_337, outputTokens: 421 },
      usdToEur,
    );
    expect(Number.isInteger(cents)).toBe(true);
  });

  it('costs nothing for an empty call', () => {
    expect(costEurCents('claude-opus-5', { inputTokens: 0, outputTokens: 0 }, usdToEur)).toBe(0);
  });

  it('only recognises models on the allowlist', () => {
    expect(isModelId('claude-opus-5')).toBe(true);
    expect(isModelId('claude-sonnet-5')).toBe(true);
    expect(isModelId('gpt-4')).toBe(false);
    expect(isModelId('claude-opus-4-1')).toBe(false);
  });

  it('keeps every allowlisted model priced', () => {
    for (const [id, rate] of Object.entries(MODELS)) {
      expect(rate.inputUsdPerMTok, id).toBeGreaterThan(0);
      expect(rate.outputUsdPerMTok, id).toBeGreaterThan(0);
      expect(rate.contextWindow, id).toBeGreaterThan(0);
    }
  });
});
