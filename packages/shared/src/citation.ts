import { citationRef, type CitationCoverage, type RetrievedChunk } from './types.js';
import type { CitationVerdict } from './spec.js';

/**
 * Citation checking lives here, beside `renderAsBuiltMarkdown`, for the same
 * reason: more than one caller has to produce the same answer.
 *
 * The SpecAgent judges a claim's citation while it normalizes a draft. The
 * read surface judges one on demand, for an agent asking "does this still
 * hold?" before it relies on a document. If those two ever disagreed, the
 * verdict would mean nothing — a claim could be `supported` in the spec and
 * `unsupported` the moment anyone checked it. One function, one answer.
 */
/**
 * Check one citation against what was retrieved, and against what could have
 * been retrieved.
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
