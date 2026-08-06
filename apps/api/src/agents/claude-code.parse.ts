/**
 * Parsing helpers for the Claude Code provider.
 *
 * The Messages API can *guarantee* a reply matches a JSON schema
 * (`output_config.format`). Driving Claude Code cannot — it returns free text,
 * and in practice that text is often wrapped in a markdown fence. So this
 * module does what the API would otherwise do for us, and does it strictly:
 * recover the JSON, or fail loudly. It never guesses at a half-parsed spec.
 */

export interface ClaudeCodeEnvelope {
  is_error?: boolean;
  result?: string;
  subtype?: string;
  stop_reason?: string;
  api_error_status?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, { canonicalModel?: string; costUSD?: number }>;
}

/**
 * Strips markdown fences and any prose either side of a JSON object.
 * Returns null when there is nothing object-shaped to recover.
 */
export function extractJson(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // A wrapping fence is one the reply *opens* with. Searching for ``` anywhere
  // would match a fence inside the JSON — and specd's payloads are markdown
  // documents that routinely contain code blocks, so that is the common case,
  // not an edge case.
  const candidate = stripWrappingFence(text);

  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;

  // Fall back to the outermost balanced {...}, so a stray "Here you go:"
  // preamble does not cost us the whole response.
  const start = candidate.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Removes a fence that wraps the whole reply, and nothing else. Anchored at
 * the start so fences *within* the payload are left alone.
 */
function stripWrappingFence(text: string): string {
  if (!text.startsWith('```')) return text;

  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) return text;

  // The opening line may carry a language tag ("```json"); anything else on it
  // means this is not a plain wrapper.
  const tag = text.slice(3, firstNewline).trim();
  if (tag && !/^[a-z]+$/i.test(tag)) return text;

  const closing = text.lastIndexOf('```');
  if (closing <= firstNewline) return text;

  return text.slice(firstNewline + 1, closing).trim();
}

export class SchemaMismatch extends Error {
  constructor(readonly missing: string[]) {
    super(`Model reply is missing required field(s): ${missing.join(', ')}`);
    this.name = 'SchemaMismatch';
  }
}

/**
 * Parses and shape-checks a reply against the schema's top-level `required`
 * keys. This is not full JSON Schema validation — it is the cheap check that
 * catches the failure that actually happens (a section silently omitted), so
 * a malformed spec never reaches a reviewer looking complete.
 */
export function parseAgainstSchema<T>(raw: string, schema: Record<string, unknown>): T {
  const json = extractJson(raw);
  if (!json) {
    // Include a sample: a bare "no JSON" is undiagnosable, and this path is
    // the one that fires when a model answers in prose instead.
    throw new Error(
      `Model reply contained no JSON object. Reply began: ${sample(raw)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Model reply was not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `Reply began: ${sample(raw)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model reply was not a JSON object.');
  }

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const missing = required.filter((key) => !(key in (parsed as Record<string, unknown>)));
  if (missing.length > 0) throw new SchemaMismatch(missing);

  return parsed as T;
}

/**
 * Renders a JSON Schema into the prompt. Without `output_config.format` this
 * is the only thing steering the shape, so it is stated as a hard contract
 * rather than a suggestion.
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    '',
    'OUTPUT CONTRACT — this is not advisory:',
    'Reply with a single JSON object and nothing else. No markdown fences, no',
    'preamble, no trailing commentary. It must validate against this schema:',
    '',
    JSON.stringify(schema, null, 2),
    '',
  ].join('\n');
}

/** A short, single-line excerpt of a model reply, for error messages. */
function sample(raw: string, max = 220): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return '(empty)';
  const head = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  // Length and terminator tell truncation apart from "answered in prose".
  return `[${raw.length} chars, ends "${flat.slice(-24)}"] ${head}`;
}
