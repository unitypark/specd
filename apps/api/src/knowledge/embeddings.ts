import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EMBEDDING_DIM } from '@specd/db';
import { Config } from '../config.js';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
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
  readonly dimensions = EMBEDDING_DIM;

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
    private readonly model = 'voyage-3.5',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
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
          input_type: 'document',
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

@Injectable()
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;

  constructor(config: Config) {
    if (config.embeddingProvider === 'voyage' && config.voyageApiKey) {
      this.provider = new VoyageEmbeddingProvider(config.voyageApiKey);
    } else {
      this.provider = new HashEmbeddingProvider();
    }
  }

  get name(): string {
    return this.provider.name;
  }

  get dimensions(): number {
    return this.provider.dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.provider.embed(texts);
  }

  async embedOne(text: string): Promise<number[]> {
    const [vec] = await this.provider.embed([text]);
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
