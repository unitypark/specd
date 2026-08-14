import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EMBEDDING_DIM } from '@specd/db';
import { Config } from '../config.js';

/**
 * Whether the text being embedded is corpus material or someone's question.
 * Asymmetric models encode the two differently and score better for it; a
 * symmetric one ignores the distinction.
 */
export type EmbeddingInput = 'document' | 'query';

export interface EmbeddingProvider {
  readonly name: string;
  /** Model identifier, or the provider name where there is no model to pick. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], input: EmbeddingInput): Promise<number[][]>;
}

/**
 * Deterministic local embedder — the default, and the reason specd needs no
 * second API key to run.
 *
 * It is honest about what it is: hashed character n-grams and tokens projected
 * into a fixed space. It captures lexical overlap, not semantics. That is
 * enough because retrieval here is *hybrid* — Postgres full-text search
 * carries relevance and this side contributes fuzzy overlap. Point
 * SPECD_EMBEDDING_PROVIDER at a real model and the dense half gets better
 * without a single query changing.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash';
  readonly model = 'hash-ngram-v1';
  readonly dimensions = EMBEDDING_DIM;

  /** Symmetric by construction: a query and a doc hash the same way. */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Float64Array(this.dimensions);
    const tokens = tokenize(text);

    for (const token of tokens) {
      // Each token contributes to a few buckets, so near-misses still overlap.
      for (let variant = 0; variant < 3; variant += 1) {
        const idx = hashToIndex(`${variant}:${token}`, this.dimensions);
        const sign = hashToIndex(`s${variant}:${token}`, 2) === 0 ? 1 : -1;
        vec[idx] = (vec[idx] ?? 0) + sign;
      }
    }

    // Character trigrams give partial credit for morphological variants
    // ("authenticate" ↔ "authentication").
    for (const token of tokens) {
      if (token.length < 5) continue;
      for (let i = 0; i + 3 <= token.length; i += 1) {
        const gram = token.slice(i, i + 3);
        const idx = hashToIndex(`g:${gram}`, this.dimensions);
        vec[idx] = (vec[idx] ?? 0) + 0.35;
      }
    }

    return l2normalize(Array.from(vec));
  }
}

/**
 * Voyage AI — Anthropic's recommended embedding partner. Opt in with
 * SPECD_EMBEDDING_PROVIDER=voyage and a VOYAGE_API_KEY.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions = EMBEDDING_DIM;

  constructor(
    private readonly apiKey: string,
    readonly model = 'voyage-3.5',
  ) {}

  async embed(texts: string[], input: EmbeddingInput = 'document'): Promise<number[][]> {
    const out: number[][] = [];
    // Voyage caps batch size; 96 keeps every request comfortably inside it.
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96);
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          // Voyage is asymmetric: a question and the passage answering it are
          // encoded differently, and embedding a query as a document throws
          // that away. The default is 'document' because that is the bulk.
          input_type: input,
          output_dimension: this.dimensions,
        }),
      });

      if (!res.ok) {
        throw new Error(`Voyage embeddings failed (${res.status}): ${await res.text()}`);
      }

      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      const sorted = [...body.data].sort((a, b) => a.index - b.index);
      out.push(...sorted.map((d) => l2normalize(d.embedding)));
    }
    return out;
  }
}

/**
 * Any OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * This is the one that lifts the ceiling the README names. The built-in hash
 * embedder is lexical by construction, so both retrieval arms measure similar
 * signals and no amount of tuning gets past it — and the only way out was a
 * cloud API key, which a local-first product should not have to require.
 * Ollama, LM Studio, llama.cpp and vLLM all speak this shape, so pointing
 * SPECD_EMBEDDING_BASE_URL at localhost buys real semantic retrieval without
 * a repository's knowledge leaving the machine.
 *
 * Symmetric, unlike Voyage: this API has no `input_type`, so a query and a
 * document are encoded the same way. That is a property of the endpoint, not a
 * simplification here — pretending otherwise would mean sending a parameter
 * these servers reject.
 */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai-compatible';
  /**
   * Whatever the server returns, discovered on the first call rather than
   * configured. Embedding dimensions vary per model (768 for
   * nomic-embed-text, 1024 for mxbai-embed-large, 1536 for
   * text-embedding-3-small — only the middle one fits this index), and a
   * number typed into an env var is a number
   * that will eventually be wrong — silently, because a mismatched vector is
   * still a vector.
   */
  private discovered: number | null = null;

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  get dimensions(): number {
    // Before the first call, report the column width the schema was built
    // with. `assertUsable()` is what actually settles this.
    return this.discovered ?? EMBEDDING_DIM;
  }

  /**
   * Ask the endpoint for one vector, and refuse now if it cannot serve this
   * index.
   *
   * pgvector columns are fixed-width. A model whose vectors do not fit the
   * column fails on insert, mid-run, after the slow half of indexing is done —
   * so the check happens at startup where the error can name the model, the
   * width it returned, and the width this index needs.
   */
  async assertUsable(): Promise<void> {
    const [probe] = await this.embed(['specd embedding probe'], 'query');
    if (!probe) throw new Error(`${this.model} at ${this.baseUrl} returned no embedding.`);
    if (probe.length !== EMBEDDING_DIM) {
      throw new Error(
        `${this.model} at ${this.baseUrl} returns ${probe.length}-dimension vectors, but this ` +
          `index stores ${EMBEDDING_DIM}. Choose a ${EMBEDDING_DIM}-dimension model ` +
          '(nomic-embed-text is one), or rebuild the index for the width you want.',
      );
    }
    this.discovered = probe.length;
  }

  async embed(texts: string[], _input: EmbeddingInput = 'document'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // A local server usually needs no key, and sending an empty bearer token
      // makes some of them reject the request outright.
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input: batch }),
      });

      if (!res.ok) {
        throw new Error(
          `Embedding request to ${this.baseUrl} failed (${res.status}): ${await res.text()}`,
        );
      }

      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      const sorted = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
      out.push(...sorted.map((d) => l2normalize(d.embedding)));
    }
    return out;
  }
}

@Injectable()
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;

  constructor(config: Config) {
    if (config.embeddingProvider === 'voyage') {
      // Falling back to the hash embedder here would be the worst kind of
      // quiet: retrieval keeps working, nothing logs, and every vector in the
      // index is silently the wrong kind. An operator who asked for Voyage
      // gets Voyage or an error.
      if (!config.voyageApiKey) {
        throw new Error(
          'SPECD_EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY. Set the key, ' +
            'or unset SPECD_EMBEDDING_PROVIDER to use the built-in hash embedder.',
        );
      }
      this.provider = new VoyageEmbeddingProvider(config.voyageApiKey);
    } else if (config.embeddingProvider === 'openai') {
      // Same discipline as Voyage above: an operator who asked for a real
      // embedder gets it or gets an error. Quietly serving hash vectors from a
      // misconfigured endpoint is the failure that hides longest.
      if (!config.embeddingBaseUrl) {
        throw new Error(
          'SPECD_EMBEDDING_PROVIDER=openai requires SPECD_EMBEDDING_BASE_URL ' +
            '(e.g. http://localhost:11434/v1 for Ollama).',
        );
      }
      this.provider = new OpenAiCompatibleEmbeddingProvider(
        config.embeddingBaseUrl,
        config.embeddingModel,
        config.embeddingApiKey,
      );
    } else {
      this.provider = new HashEmbeddingProvider();
    }
  }

  get name(): string {
    return this.provider.name;
  }

  /**
   * Settle anything the provider could only learn by asking. Called at
   * startup so a wrong model fails where the message can be read, rather
   * than on an insert halfway through the first index run.
   */
  async assertUsable(): Promise<void> {
    if (this.provider instanceof OpenAiCompatibleEmbeddingProvider) {
      await this.provider.assertUsable();
    }
  }

  get dimensions(): number {
    return this.provider.dimensions;
  }

  /**
   * Identity of the vectors this service produces. Two indexes built with
   * different fingerprints hold vectors from different spaces, and cosine
   * distance between them is noise — so this is what the indexer stamps on a
   * chunk's doc and compares on the next run.
   */
  get fingerprint(): string {
    return `${this.provider.name}/${this.provider.model}/${this.provider.dimensions}`;
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.provider.embed(texts, 'document');
  }

  /** Embed a search query — see {@link EmbeddingInput}. */
  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.provider.embed([text], 'query');
    if (!vec) throw new Error('embedding provider returned nothing');
    return vec;
  }

  /** pgvector literal: '[0.1,0.2,...]'. */
  static toSqlVector(vec: number[]): string {
    return `[${vec.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
  }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'we', 'you', 'they', 'not', 'no', 'if',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/.#-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function hashToIndex(input: string, modulo: number): number {
  const digest = createHash('sha1').update(input).digest();
  const value = digest.readUInt32BE(0);
  return value % modulo;
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
