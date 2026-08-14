import { citationRef, type CitationCoverage, type RetrievedChunk } from './types.js';
import type { CitationVerdict } from './spec.js';

/**
 * Check one citation against what was retrieved, and against what could have
 * been retrieved.
 *
 * This lives beside `renderAsBuiltMarkdown` for the same reason that does:
 * more than one caller has to produce the same answer. The SpecAgent judges a
 * claim's citation while it normalizes a draft; the read surface judges one on
 * demand, for an agent asking "does this still hold?" before relying on a
 * document. If those two disagreed the verdict would mean nothing — a claim
 * could be `supported` in the spec and `unsupported` the moment anyone checked
 * it. One function, one answer.
 *
 * The three-way split is the point. A binary check can only ask "was this in
 * the prompt", so a real doc that simply did not make the top-k is reported
 * identically to an invented one — and a reviewer who learns that the marker
 * cries wolf stops reading it. Separating them means an UNSUPPORTED verdict
 * is worth acting on, and an UNKNOWN verdict says which gap to close.
 */
export function judgeCitation(
  citation: string,
  chunks: RetrievedChunk[],
  coverage: CitationCoverage | undefined,
): { citation?: string; unverified?: string; verdict: CitationVerdict } {
  const [rawPath = '', anchor] = citation.split('#');
  const path = rawPath.trim();

  // Exactly what was put in front of the model: the strongest answer there is,
  // unless the passage itself describes code that has since moved.
  if (chunks.some((chunk) => citationRef(chunk) === citation)) {
    return stalenessOf(path, anchor, coverage) ?? { citation, verdict: 'supported' };
  }

  const retrievedPaths = new Set(chunks.map((c) => c.path));

  // Without coverage there is no way to tell a gap from a fabrication, so fall
  // back to the old rule rather than accusing the model of inventing a doc we
  // simply cannot check.
  if (!coverage) {
    return retrievedPaths.has(path)
      ? { citation, verdict: 'supported' }
      : {
          unverified: `cited "${citation}", which is not in the retrieved knowledge — verify by hand`,
          verdict: 'unsupported',
        };
  }

  if (!coverage.knownPaths.includes(path)) {
    return {
      unverified: `cited "${citation}" — no such doc in the knowledge base`,
      verdict: 'unsupported',
    };
  }

  if (coverage.unretrievablePaths.includes(path)) {
    return {
      citation,
      unverified: `cites "${citation}", a doc that holds no indexed content — retrieval could not see it, so this is unchecked rather than wrong`,
      verdict: 'unknown',
    };
  }

  if (!retrievedPaths.has(path)) {
    const budget =
      coverage.truncatedCount > 0
        ? ` (${coverage.truncatedCount} matching chunk(s) were cut for budget)`
        : '';
    return {
      citation,
      unverified: `cites "${citation}", a real doc that was not among the retrieved chunks${budget} — confirm the section says this`,
      verdict: 'unknown',
    };
  }

  // The doc was retrieved. If the anchor is not one of its headings at all,
  // that is a fabricated section and checkable as such.
  if (anchor) {
    const anchors = coverage.anchorsByPath[path];
    if (anchors && !anchors.includes(anchor)) {
      return {
        unverified: `cited "${citation}" — "${path}" has no section "${anchor}"`,
        verdict: 'unsupported',
      };
    }
    return {
      citation,
      unverified: `cites "${citation}"; that section exists but was not among the retrieved chunks of the doc — confirm it says this`,
      verdict: 'unknown',
    };
  }

  // A bare path whose doc was retrieved: the claim points at the doc as a
  // whole, and the doc is in front of the model.
  return stalenessOf(path, anchor, coverage) ?? { citation, verdict: 'supported' };
}

/**
 * Whether a citation lands on prose that describes code which has moved.
 *
 * A different question from the three verdicts around it. Those ask how well
 * the citation could be checked; this asks whether what it points at is still
 * true. A claim can be perfectly supported by a paragraph nobody has revisited
 * since the code under it was rewritten, and saying "supported" there is
 * accurate about the evidence and misleading about the world.
 *
 * Section-scoped: a stale reference in a doc's deployment section says nothing
 * about its data-model section. Tainting the whole doc is how a caveat stops
 * being read.
 */
function stalenessOf(
  path: string,
  anchor: string | undefined,
  coverage: CitationCoverage | undefined,
): { citation: string; unverified: string; verdict: CitationVerdict } | null {
  const stale = coverage?.staleSections?.[path];
  if (!stale) return null;
  if (!stale.wholeDoc && !(anchor && stale.sections.includes(anchor))) return null;

  const where = anchor ? `"${path}#${anchor}"` : `"${path}"`;
  return {
    citation: anchor ? `${path}#${anchor}` : path,
    unverified:
      `${where} describes code that has changed since the doc was last touched ` +
      `(\`${stale.detail}\`) — the passage may be accurate and out of date`,
    verdict: 'stale',
  };
}

/** One claim whose evidence no longer stands where it did at approval. */
export interface CitationDrift {
  claim: string;
  citation: string;
  /** The verdict recorded when a human approved this spec. */
  was: CitationVerdict;
  /** What the same citation judges to now. */
  now: CitationVerdict;
  /** The sentence explaining the new verdict, for whoever has to act on it. */
  note: string | null;
}

/**
 * Which of an approved spec's citations no longer stand.
 *
 * A spec approved on Monday can build on Friday against a knowledge base that
 * merged on Wednesday. The gate is re-checked at the point of use — approval
 * can be revoked between click and build — but the *evidence* was checked once,
 * at drafting, and never again. So a design claim can arrive at the build
 * station citing a section that has since been rewritten, deleted, or overtaken
 * by the code it describes, and nothing says so.
 *
 * Only degradation is reported. A claim that was `unknown` at approval and is
 * `supported` now needs nobody's attention; the reviewer already accepted the
 * weaker state. And a claim with no recorded verdict is skipped rather than
 * guessed at — specs drafted before verdicts existed would otherwise all read
 * as having drifted.
 */
export function citationDrift(
  design: { text: string; citation?: string; verdict?: CitationVerdict }[],
  chunks: RetrievedChunk[],
  coverage: CitationCoverage,
): CitationDrift[] {
  // Best to worst. A move down this list is what "drifted" means.
  const rank: Record<CitationVerdict, number> = {
    supported: 0,
    stale: 1,
    unknown: 2,
    unsupported: 3,
  };

  const drifted: CitationDrift[] = [];
  for (const claim of design) {
    if (!claim.citation || !claim.verdict) continue;
    const judged = judgeCitation(claim.citation, chunks, coverage);
    if (rank[judged.verdict] <= rank[claim.verdict]) continue;
    drifted.push({
      claim: claim.text,
      citation: claim.citation,
      was: claim.verdict,
      now: judged.verdict,
      note: judged.unverified ?? null,
    });
  }
  return drifted;
}
