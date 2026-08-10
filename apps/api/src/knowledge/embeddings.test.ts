import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import {
  EmbeddingService,
  HashEmbeddingProvider,
  VoyageEmbeddingProvider,
} from './embeddings.js';

const provider = new HashEmbeddingProvider();

/** Only the two fields the service reads. */
const configWith = (embeddingProvider: 'hash' | 'voyage', voyageApiKey: string): Config =>
  ({ embeddingProvider, voyageApiKey }) as unknown as Config;

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

describe('embedding service selection', () => {
  it('uses the hash embedder by default', () => {
    const service = new EmbeddingService(configWith('hash', ''));
    expect(service.name).toBe('hash');
    expect(service.fingerprint).toBe('hash/hash-ngram-v1/1024');
  });

  it('refuses to start when voyage is configured without a key', () => {
    // Quietly falling back would leave retrieval working, nothing logged, and
    // every vector in the index the wrong kind.
    expect(() => new EmbeddingService(configWith('voyage', ''))).toThrow(/requires VOYAGE_API_KEY/);
  });

  it('fingerprints the provider, model and width it produces', () => {
    const service = new EmbeddingService(configWith('voyage', 'vk-test'));
    expect(service.fingerprint).toBe('voyage/voyage-3.5/1024');
  });
});

describe('voyage provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Captures request bodies and answers with one vector per input. */
  const stubFetch = () => {
    const bodies: { input: string[]; input_type: string }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return {
        ok: true,
        json: async () => ({
          data: body.input.map((_: string, index: number) => ({ embedding: [1, 0, 0], index })),
        }),
      };
    });
    return bodies;
  };

  it('embeds corpus material as documents', async () => {
    const bodies = stubFetch();
    await new VoyageEmbeddingProvider('vk-test').embed(['a passage'], 'document');
    expect(bodies[0]?.input_type).toBe('document');
  });

  it('embeds a search query as a query', async () => {
    // Voyage is asymmetric; embedding the question as a passage throws away
    // the distinction the model was trained to make.
    const bodies = stubFetch();
    await new EmbeddingService(configWith('voyage', 'vk-test')).embedQuery('how does auth work');
    expect(bodies[0]?.input_type).toBe('query');
  });
});
