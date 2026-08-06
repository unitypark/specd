import { describe, expect, it } from 'vitest';
import { EmbeddingService, HashEmbeddingProvider } from './embeddings.js';

const provider = new HashEmbeddingProvider();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // vectors are L2-normalized, so the dot product is the cosine
}

describe('hash embedding provider', () => {
  it('is deterministic', async () => {
    const [a] = await provider.embed(['the outbox worker delivers webhooks']);
    const [b] = await provider.embed(['the outbox worker delivers webhooks']);
    expect(a).toEqual(b);
  });

  it('produces unit vectors of the indexed width', async () => {
    const [vec] = await provider.embed(['contacts are workspace scoped']);
    expect(vec).toHaveLength(provider.dimensions);
    expect(cosine(vec!, vec!)).toBeCloseTo(1, 5);
  });

  it('scores related text above unrelated text', async () => {
    const [auth, authSimilar, unrelated] = await provider.embed([
      'authentication runs behind the auth facade with strategies',
      'the authentication facade registers auth strategies',
      'the quarterly marketing budget spreadsheet for catering',
    ]);
    expect(cosine(auth!, authSimilar!)).toBeGreaterThan(cosine(auth!, unrelated!));
  });

  it('gives partial credit for morphological variants', async () => {
    const [a, b, c] = await provider.embed([
      'authenticate the request',
      'authentication of the request',
      'delete the request',
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });

  it('handles empty input without producing NaN', async () => {
    const [vec] = await provider.embed(['']);
    expect(vec).toHaveLength(provider.dimensions);
    expect(vec!.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('serializes to a pgvector literal', () => {
    const literal = EmbeddingService.toSqlVector([0.5, -0.25, 0]);
    expect(literal).toBe('[0.500000,-0.250000,0.000000]');
  });

  it('never emits NaN into a pgvector literal', () => {
    expect(EmbeddingService.toSqlVector([Number.NaN, Infinity])).toBe('[0,0]');
  });
});
