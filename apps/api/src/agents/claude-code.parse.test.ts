import { describe, expect, it } from 'vitest';
import {
  SchemaMismatch,
  extractJson,
  parseAgainstSchema,
  schemaInstruction,
} from './claude-code.parse.js';

const schema = {
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'number' } },
  required: ['a', 'b'],
} as Record<string, unknown>;

describe('extractJson', () => {
  it('takes bare JSON as-is', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
    expect(extractJson('  \n {"a":1}  \n ')).toBe('{"a":1}');
  });

  it('unwraps a ```json fence — the common case in practice', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('rescues JSON buried in prose', () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it('handles nested objects without stopping at the first brace', () => {
    const nested = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJson(`prose ${nested} more prose`)).toBe(nested);
  });

  it('is not fooled by braces inside strings', () => {
    const tricky = '{"a":"a } brace","b":2}';
    expect(extractJson(tricky)).toBe(tricky);
  });

  it('is not fooled by escaped quotes', () => {
    const tricky = '{"a":"he said \\"} hi\\"","b":2}';
    expect(extractJson(tricky)).toBe(tricky);
  });

  it('leaves code fences that live INSIDE the JSON alone', () => {
    // specd's payloads are markdown documents, so fenced code blocks inside a
    // string value are the norm. Treating the first ``` as a wrapper truncated
    // every knowledge draft that contained one.
    const doc = JSON.stringify({
      conventions: '## Verify\n\n```sh\npnpm lint && pnpm test\n```\n\nDone.',
      architecture: 'See `src/main.ts`.',
    });
    expect(extractJson(doc)).toBe(doc);
    expect(JSON.parse(extractJson(doc)!).conventions).toContain('pnpm lint');
  });

  it('unwraps an outer fence even when the payload contains fences', () => {
    const doc = JSON.stringify({ a: '```sh\necho hi\n```' });
    expect(extractJson('```json\n' + doc + '\n```')).toBe(doc);
  });

  it('does not mistake a prose ``` for a wrapper', () => {
    const doc = '{"a":"use ``` to fence"}';
    expect(extractJson(doc)).toBe(doc);
  });

  it('returns null when there is nothing to recover', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('   ')).toBeNull();
    expect(extractJson('I cannot help with that.')).toBeNull();
  });

  it('returns null on an unterminated object rather than half of one', () => {
    expect(extractJson('{"a":1')).toBeNull();
  });
});

describe('parseAgainstSchema', () => {
  it('parses a valid reply', () => {
    expect(parseAgainstSchema('```json\n{"a":"x","b":2}\n```', schema)).toEqual({ a: 'x', b: 2 });
  });

  it('names the missing fields, so the repair prompt can be specific', () => {
    // This is the failure that actually matters: a section silently omitted
    // would otherwise reach a reviewer looking complete.
    try {
      parseAgainstSchema('{"a":"x"}', schema);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaMismatch);
      expect((err as SchemaMismatch).missing).toEqual(['b']);
    }
  });

  it('refuses a JSON array where an object is required', () => {
    expect(() => parseAgainstSchema('[1,2,3]', schema)).toThrow(/no JSON object|not a JSON object/);
  });

  it('refuses malformed JSON rather than guessing', () => {
    expect(() => parseAgainstSchema('{"a":"x", "b":}', schema)).toThrow(/not valid JSON/);
  });

  it('refuses a refusal', () => {
    expect(() => parseAgainstSchema('I cannot help with that.', schema)).toThrow(
      /no JSON object/,
    );
  });

  it('accepts extra keys — only the required ones are contractual', () => {
    expect(parseAgainstSchema('{"a":"x","b":1,"extra":true}', schema)).toMatchObject({
      a: 'x',
      b: 1,
    });
  });
});

describe('schemaInstruction', () => {
  it('states the contract and embeds the schema', () => {
    const text = schemaInstruction(schema);
    expect(text).toContain('OUTPUT CONTRACT');
    expect(text).toContain('No markdown fences');
    expect(text).toContain('"required"');
  });
});
