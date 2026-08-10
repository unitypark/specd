import { anchorOf } from './link-resolve.js';

export interface Chunk {
  ord: number;
  heading: string | null;
  text: string;
  tokens: number;
}

const MAX_CHARS = 1_800;
const MIN_CHARS = 120;

/**
 * Markdown-aware chunking. Splits on headings first so a chunk is a coherent
 * idea rather than an arbitrary window, then splits over-long sections on
 * paragraph boundaries.
 *
 * The heading matters beyond retrieval quality: it becomes the anchor in a
 * citation (`knowledge/architecture.md#auth`), which is what makes a spec's
 * design claims checkable by a human.
 */
/**
 * Identity of the chunking rules. Bump on any change that would give the same
 * markdown different chunks — the bounds above, the fence handling, the
 * scrap-folding rule. It rides the index fingerprint, so a bump re-chunks and
 * re-embeds every doc rather than leaving old rows behind.
 */
export const CHUNKER_VERSION = `v1/${MAX_CHARS}/${MIN_CHARS}`;

export function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split('\n');
  const sections: { heading: string | null; body: string[] }[] = [];
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const headingMatch = !inFence ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (headingMatch) {
      if (current.body.some((l) => l.trim())) sections.push(current);
      current = { heading: headingMatch[2]?.trim() ?? null, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.some((l) => l.trim())) sections.push(current);

  const chunks: Chunk[] = [];
  let ord = 0;

  for (const section of sections) {
    const body = section.body.join('\n').trim();
    if (!body) continue;

    for (const piece of splitToSize(body)) {
      const text = piece.trim();
      if (text.length < MIN_CHARS && chunks.length > 0 && section.heading === null) {
        // Fold a scrap into the previous chunk rather than indexing noise.
        const prev = chunks[chunks.length - 1];
        if (prev) {
          prev.text = `${prev.text}\n${text}`;
          prev.tokens = estimateTokens(prev.text);
          continue;
        }
      }
      chunks.push({
        ord: ord++,
        heading: section.heading,
        text,
        tokens: estimateTokens(text),
      });
    }
  }

  return chunks;
}

function splitToSize(body: string): string[] {
  if (body.length <= MAX_CHARS) return [body];

  const paragraphs = body.split(/\n{2,}/);
  const out: string[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (buffer && buffer.length + para.length + 2 > MAX_CHARS) {
      out.push(buffer);
      buffer = para;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }

    // A single paragraph longer than the budget (a big table or code block)
    // gets hard-split rather than silently dropped.
    while (buffer.length > MAX_CHARS) {
      out.push(buffer.slice(0, MAX_CHARS));
      buffer = buffer.slice(MAX_CHARS);
    }
  }

  if (buffer.trim()) out.push(buffer);
  return out;
}

/** Rough estimate for budgeting only — never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.7);
}

/** Anchor form used in citations: "Auth flow" → "auth-flow". */
/**
 * Anchor for a chunk's heading — the `#auth` half of a citation.
 *
 * Delegates to the shared resolver rather than slugifying here. It used to
 * have its own recipe (`[^a-z0-9]+`), which disagreed with the resolver's on
 * anything outside ASCII: "Café notes" became `caf-notes` on this side and
 * `café-notes` on that one, and a CJK heading collapsed to the empty string.
 * Once citation checking began comparing the two namespaces — a chunk's
 * anchor against a doc's real headings — that disagreement stopped being
 * cosmetic and started reporting sound citations as unchecked. S-102 asked
 * for one shared normalize module; this is it.
 */
export function headingAnchor(heading: string | null): string | null {
  if (!heading) return null;
  return anchorOf(heading) || null;
}
