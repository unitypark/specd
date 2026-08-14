import type { DocCategory, DocPage } from './types';
import { START } from './start';
import { CONCEPTS } from './concepts';
import { GUIDES } from './guides';
import { INTEGRATIONS } from './integrations';
import { REFERENCE } from './reference';
import { TEAMS } from './teams';

export * from './types';

/**
 * The documentation, in reading order.
 *
 * Category order is the order a newcomer should meet them: what it is, why,
 * how to run it, then the reference material they will come back to. The
 * sidebar renders this array top to bottom, and so does the static site.
 */
export const DOCS: DocCategory[] = [START, CONCEPTS, GUIDES, INTEGRATIONS, REFERENCE, TEAMS];

/** Every page, flattened, in sidebar order — which is also prev/next order. */
export const PAGES: DocPage[] = DOCS.flatMap((c) => c.pages);

export function findPage(slug: string): DocPage | undefined {
  return PAGES.find((p) => p.slug === slug);
}

export function categoryOf(slug: string): DocCategory | undefined {
  return DOCS.find((c) => c.pages.some((p) => p.slug === slug));
}

/**
 * The pages either side of this one, for the footer pager. Reading straight
 * through the sidebar is a real way people use documentation, and a pager is
 * what makes it possible without going back to the index every time.
 */
export function neighbours(slug: string): { prev?: DocPage; next?: DocPage } {
  const i = PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) return {};
  return { prev: PAGES[i - 1], next: PAGES[i + 1] };
}

/** Human label for the audience chip. */
export const AUDIENCE_LABEL: Record<DocPage['audience'], string> = {
  everyone: 'Everyone',
  engineering: 'Engineering',
  leadership: 'Leadership',
};
