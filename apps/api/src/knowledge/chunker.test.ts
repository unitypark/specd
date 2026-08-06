import { describe, expect, it } from 'vitest';
import { chunkMarkdown, headingAnchor } from './chunker.js';

describe('markdown chunking', () => {
  it('splits on headings so a chunk is one idea', () => {
    const doc = `# Architecture

Intro paragraph that is long enough to survive the minimum-size fold, because
short scraps get merged into their neighbour rather than indexed as noise.

## Auth

Auth runs behind a facade. Strategies register with it, so the rest of the app
never depends on how a session was established in the first place.

## Events

The outbox worker delivers webhooks out of band, never in the request path,
so a slow integration partner cannot slow down a user's request.`;

    const chunks = chunkMarkdown(doc);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('Auth');
    expect(headings).toContain('Events');

    const auth = chunks.find((c) => c.heading === 'Auth');
    expect(auth?.text).toContain('facade');
    expect(auth?.text).not.toContain('outbox worker');
  });

  it('ignores headings inside fenced code', () => {
    const doc = `## Real heading

Some prose that is easily long enough to stand as its own chunk without being
folded into a neighbour by the minimum-size rule.

\`\`\`sh
# not a heading
## definitely not a heading
\`\`\``;

    const headings = chunkMarkdown(doc).map((c) => c.heading);
    expect(headings).toContain('Real heading');
    expect(headings).not.toContain('not a heading');
  });

  it('splits an over-long section instead of dropping it', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`).join(
      '\n\n',
    );
    const chunks = chunkMarkdown(`## Big\n\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2_000);
    }
    // Nothing vanished.
    expect(chunks.map((c) => c.text).join(' ')).toContain('Paragraph 39');
  });

  it('hard-splits a single paragraph longer than the budget', () => {
    const chunks = chunkMarkdown(`## Huge\n\n${'x'.repeat(9_000)}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.reduce((n, c) => n + c.text.length, 0)).toBeGreaterThanOrEqual(9_000 - 10);
  });

  it('numbers chunks in document order', () => {
    const chunks = chunkMarkdown('## A\n\n' + 'a'.repeat(400) + '\n\n## B\n\n' + 'b'.repeat(400));
    expect(chunks.map((c) => c.ord)).toEqual([...chunks.keys()]);
  });

  it('returns nothing for an empty document', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n  ')).toEqual([]);
  });

  it('anchors headings the way a citation refers to them', () => {
    expect(headingAnchor('Auth flow')).toBe('auth-flow');
    expect(headingAnchor('Data & Storage!')).toBe('data-storage');
    expect(headingAnchor(null)).toBeNull();
  });
});
