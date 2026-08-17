import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config.js';
import {
  EmbeddingService,
  HashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
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
      const payload = {
        data: body.input.map((_: string, index: number) => ({ embedding: [1, 0, 0], index })),
      };
      return {
        ok: true,
        status: 200,
        // `text` as well as `json`: the provider reads the body as text so a
        // login page becomes an explanation rather than a SyntaxError.
        text: async () => JSON.stringify(payload),
        json: async () => payload,
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

describe('an OpenAI-compatible endpoint', () => {
  const serve = (handler: (body: unknown) => { status?: number; json?: unknown; text?: string }) => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchMock = async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body,
      });
      const res = handler(body);
      return {
        ok: (res.status ?? 200) < 400,
        status: res.status ?? 200,
        json: async () => res.json,
        text: async () => res.text ?? (res.json === undefined ? '' : JSON.stringify(res.json)),
      } as Response;
    };
    return { calls, fetchMock };
  };

  const vectors = (dim: number) => (body: unknown) => ({
    json: {
      data: (body as { input: string[] }).input.map((_, index) => ({
        index,
        embedding: Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)),
      })),
    },
  });

  it('posts to /embeddings on the configured base url', async () => {
    const { calls, fetchMock } = serve(vectors(1024));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleEmbeddingProvider(
      'http://localhost:11434/v1/',
      'nomic-embed-text',
      '',
    );
    await provider.embed(['hello']);
    // The trailing slash in the configured url must not produce a double one.
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/embeddings');
    expect(calls[0]!.body).toMatchObject({ model: 'nomic-embed-text' });
    vi.unstubAllGlobals();
  });

  it('sends no Authorization header when there is no key', async () => {
    // A local server usually needs none, and an empty bearer token makes some
    // of them reject the request outright.
    const { calls, fetchMock } = serve(vectors(1024));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAiCompatibleEmbeddingProvider('http://localhost:11434/v1', 'm', '').embed(['x']);
    expect(calls[0]!.headers.Authorization).toBeUndefined();

    await new OpenAiCompatibleEmbeddingProvider('http://localhost:11434/v1', 'm', 'k').embed(['x']);
    expect(calls[1]!.headers.Authorization).toBe('Bearer k');
    vi.unstubAllGlobals();
  });

  it('refuses a model whose vectors do not fit the index, and says which', async () => {
    // pgvector columns are fixed-width, so a mismatch otherwise fails on
    // insert — mid-run, after the slow half of indexing is already done.
    const { fetchMock } = serve(vectors(768));
    vi.stubGlobal('fetch', fetchMock);
    // nomic-embed-text is 768: the obvious first choice, and the wrong one.
    const provider = new OpenAiCompatibleEmbeddingProvider(
      'http://localhost:11434/v1',
      'nomic-embed-text',
      '',
    );
    await expect(provider.assertUsable()).rejects.toThrow(/768-dimension/);
    await expect(provider.assertUsable()).rejects.toThrow(/nomic-embed-text/);
    vi.unstubAllGlobals();
  });

  it('accepts a model that fits', async () => {
    const { fetchMock } = serve(vectors(1024));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiCompatibleEmbeddingProvider('http://localhost:11434/v1', 'm', '');
    await expect(provider.assertUsable()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('reports the endpoint failing rather than returning empty vectors', async () => {
    // Silently degrading here would leave every chunk holding a wrong vector,
    // with retrieval still "working" and nothing logged.
    const { fetchMock } = serve(() => ({ status: 500, text: 'model not found' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new OpenAiCompatibleEmbeddingProvider('http://localhost:11434/v1', 'm', '').embed(['x']),
    ).rejects.toThrow(/failed \(500\).*model not found/s);
    vi.unstubAllGlobals();
  });

  it('gives the index a different fingerprint from the hash embedder', () => {
    // Two indexes built with different embedders hold vectors from different
    // spaces; the fingerprint is what forces a re-embed instead of mixing them.
    const local = new EmbeddingService({
      embeddingProvider: 'openai',
      embeddingBaseUrl: 'http://localhost:11434/v1',
      embeddingModel: 'mxbai-embed-large',
      embeddingApiKey: '',
    } as unknown as Config);
    const hash = new EmbeddingService({ embeddingProvider: 'hash' } as unknown as Config);
    expect(local.fingerprint).not.toBe(hash.fingerprint);
    expect(local.name).toBe('openai-compatible');
  });

  it('refuses to start with no endpoint configured', () => {
    expect(
      () =>
        new EmbeddingService({
          embeddingProvider: 'openai',
          embeddingBaseUrl: '',
        } as unknown as Config),
    ).toThrow(/SPECD_EMBEDDING_BASE_URL/);
  });
});
