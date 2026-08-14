import { describe, expect, it } from 'vitest';
import { GALLERY, galleryEntry, galleryPack } from './gallery.js';

/**
 * The gallery's one job is to be true.
 *
 * It is the page a stranger reaches from a search result, and §15's first
 * named risk is specd feeling like a doc-spam machine — so a gallery showing
 * output the product would not really produce is the worst possible version
 * of this feature. These tests exist to make that impossible rather than
 * unlikely: every entry is run through the product's own `detectStack` and
 * templates, and what the page shows is what those returned.
 */

describe('gallery entries', () => {
  it('has a unique slug per entry', () => {
    const slugs = GALLERY.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('advertises no stack specd cannot actually detect', () => {
    // The whole premise. If someone adds an entry for a framework the
    // detector does not know, this fails rather than shipping a page that
    // promises detection that will not happen.
    for (const entry of GALLERY) {
      const { stack } = galleryPack(entry);
      expect(stack.language, `${entry.slug} was not detected`).not.toBe('unknown');
    }
  });

  it('detects a verify command for every entry, since the build station runs it', () => {
    for (const entry of GALLERY) {
      const { stack } = galleryPack(entry);
      expect(stack.verifyCommand, `${entry.slug} has no verify command`).toBeTruthy();
    }
  });

  it('detects the language and framework each page claims to be about', () => {
    const expected: Record<string, { language: string; framework?: string }> = {
      nestjs: { language: 'TypeScript', framework: 'NestJS' },
      nextjs: { language: 'TypeScript', framework: 'Next.js' },
      django: { language: 'Python', framework: 'Django' },
      fastapi: { language: 'Python', framework: 'FastAPI' },
      go: { language: 'Go' },
      rust: { language: 'Rust' },
      rails: { language: 'Ruby', framework: 'Rails' },
      terraform: { language: 'Terraform' },
    };

    for (const entry of GALLERY) {
      const { stack } = galleryPack(entry);
      const want = expected[entry.slug];
      expect(want, `no expectation recorded for ${entry.slug}`).toBeTruthy();
      expect(stack.language, entry.slug).toBe(want!.language);
      if (want!.framework) expect(stack.framework, entry.slug).toBe(want!.framework);
    }
  });
});

describe('galleryPack', () => {
  const nest = galleryPack(galleryEntry('nestjs')!);

  it('renders the working agreements, not a paraphrase of them', () => {
    // These are the rules the whole product exists to install. A gallery that
    // showed a prettier version of them would be advertising something else.
    expect(nest.agentsMd).toContain('Knowledge first — no exceptions');
    expect(nest.agentsMd).toContain('specd spec pull');
    expect(nest.agentsMd).toContain('knowledge/specs/');
  });

  it('carries the detected stack into the file the agent actually reads', () => {
    expect(nest.summary).toContain('NestJS');
    expect(nest.summary).toContain('pnpm');
    expect(nest.agentsMd).toContain(nest.stack.verifyCommand!);
    // `[detected]` is the templates' own marker for "this came from the scan,
    // not from a model" — losing it would blur exactly the line that matters.
    expect(nest.agentsMd).toContain('[detected]');
  });

  it('produces the full scaffold, including the folder the Learn loop writes to', () => {
    const paths = nest.files.map((f) => f.path);
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('knowledge/README.md');
    expect(paths.some((p) => p.startsWith('knowledge/specs/'))).toBe(true);
    for (const file of nest.files) {
      expect(file.content.length, `${file.path} is empty`).toBeGreaterThan(0);
    }
  });

  it('marks generated knowledge as a draft rather than presenting it as verified', () => {
    // §6's guardrail — the wizard must not lie — applies just as much to the
    // marketing page showing what the wizard writes.
    const readme = nest.files.find((f) => f.path === 'knowledge/README.md')!;
    expect(readme.content).toMatch(/DRAFT/);
  });

  it('is deterministic, so a statically generated page is not a diff every build', () => {
    const a = galleryPack(galleryEntry('go')!);
    const b = galleryPack(galleryEntry('go')!);
    expect(a.agentsMd).toBe(b.agentsMd);
    expect(a.files.map((f) => f.content).join()).toBe(b.files.map((f) => f.content).join());
  });

  it('renders a different verify command per stack, because it is really detected', () => {
    const commands = GALLERY.map((e) => galleryPack(e).stack.verifyCommand);
    expect(new Set(commands).size).toBeGreaterThan(3);
    expect(galleryPack(galleryEntry('go')!).stack.verifyCommand).toContain('go test');
    expect(galleryPack(galleryEntry('rust')!).stack.verifyCommand).toContain('clippy');
  });
});
