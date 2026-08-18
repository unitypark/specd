import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { MODELS, type ModelId, type TokenUsage, STATION_EFFORT, type Effort } from '@specd/shared';
import { AiNotConfigured } from '../common/errors.js';

export interface ModelCallOptions {
  apiKey: string;
  model: ModelId;
  system: string;
  user: string;
  /** JSON Schema. When set, the reply is guaranteed to match it. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  effort?: Effort;
  /** Called with every text delta, so a run log can stream while it thinks. */
  onDelta?: (text: string) => void;
}

export interface ModelCallResult<T = string> {
  text: string;
  parsed?: T;
  usage: TokenUsage;
  model: ModelId;
  stopReason: string | null;
}

export class ModelRefusal extends Error {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(
      `The model declined this request${category ? ` (${category})` : ''}. ` +
        (explanation ?? 'Nothing was generated.'),
    );
    this.name = 'ModelRefusal';
  }
}

/**
 * The one place that talks to Claude. Everything agent-shaped goes through
 * here so metering, refusal handling and log streaming are impossible to
 * forget in a new agent.
 *
 * Streaming is the default: spec drafting produces long output, and a
 * non-streaming request at these token counts risks an HTTP timeout.
 */
@Injectable()
export class AnthropicService {
  isConfigured(apiKey: string | null): boolean {
    return Boolean(apiKey);
  }

  async call<T = unknown>(opts: ModelCallOptions): Promise<ModelCallResult<T>> {
    if (!opts.apiKey) {
      throw new AiNotConfigured(
        'No Anthropic API key is available for this project. Add one in Settings → AI, ' +
          'or set ANTHROPIC_API_KEY for managed-cloud mode.',
      );
    }

    const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
    const maxTokens = opts.maxTokens ?? 32_000;

    const stream = client.messages.stream({
      model: opts.model,
      max_tokens: maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      // Adaptive thinking: Claude decides how much to think per request, and
      // `effort` sets the ceiling on total spend.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: opts.effort ?? STATION_EFFORT.spec,
        ...(opts.schema
          ? { format: { type: 'json_schema' as const, schema: opts.schema } }
          : {}),
      },
    });

    if (opts.onDelta) {
      stream.on('text', (delta: string) => opts.onDelta?.(delta));
    }

    const message = await stream.finalMessage();

    const usage: TokenUsage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    };

    // Check the stop reason before touching content: on a refusal the content
    // array is empty or partial, and indexing into it would throw.
    if (message.stop_reason === 'refusal') {
      const details = message.stop_details;
      throw new ModelRefusal(
        details && 'category' in details ? (details.category ?? null) : null,
        details && 'explanation' in details ? (details.explanation ?? null) : null,
      );
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (message.stop_reason === 'max_tokens') {
      throw new Error(
        `The model hit its ${maxTokens}-token output limit before finishing. ` +
          'Try a smaller ticket, or raise the limit.',
      );
    }

    let parsed: T | undefined;
    if (opts.schema) {
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        throw new Error('The model returned malformed JSON despite a schema constraint.');
      }
    }

    return { text, parsed, usage, model: opts.model, stopReason: message.stop_reason };
  }

  /** Pre-flight token count, so a run can refuse before it spends anything. */
  async countTokens(apiKey: string, model: ModelId, system: string, user: string): Promise<number> {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.countTokens({
      model,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return res.input_tokens;
  }

  contextWindow(model: ModelId): number {
    return MODELS[model].contextWindow;
  }
}
