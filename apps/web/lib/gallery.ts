import {
  describeStack,
  detectStack,
  renderAgentsMd,
  renderScaffold,
  type DetectedStack,
  type ScaffoldFile,
} from '@specd/templates';

/**
 * The template gallery — one page per stack, each showing exactly what specd
 * would write into a repo of that shape.
 *
 * The important design choice: **nothing here is written by hand.** An entry
 * carries the *manifest a repo of that kind would have*, and the page runs the
 * product's own `detectStack` over it and renders with the product's own
 * templates. So the gallery cannot advertise a stack specd fails to detect, or
 * show an `AGENTS.md` it would not actually produce — the two cannot drift,
 * because there is only one of them.
 *
 * That matters more here than anywhere else in the app. This is the page a
 * stranger lands on from a search result, and §15's first named risk is the
 * product feeling like a doc-spam machine. Showing generated output that is
 * really generated is the cheapest possible defence.
 */

export interface GalleryEntry {
  slug: string;
  /** What a visitor searched for. */
  title: string;
  blurb: string;
  /** A plausible repo of this kind, used for the rendered example. */
  repoName: string;
  /** The manifest files `detectStack` reads. */
  sample: { files: { path: string; content: string }[]; fileList: string[] };
  /** Directories the scan would find, for the architecture draft. */
  topLevelDirs: string[];
  entryPoints: string[];
  glossaryTerms: string[];
}

const pkg = (body: Record<string, unknown>) => JSON.stringify(body, null, 2);

export const GALLERY: GalleryEntry[] = [
  {
    slug: 'nestjs',
    title: 'NestJS',
    blurb: 'TypeScript API with pnpm and Vitest — the shape specd itself is built in.',
    repoName: 'acme/orders-api',
    sample: {
      fileList: ['package.json', 'tsconfig.json', 'pnpm-lock.yaml'],
      files: [
        {
          path: 'package.json',
          content: pkg({
            name: 'orders-api',
            packageManager: 'pnpm@10.32.1',
            scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run' },
            dependencies: { '@nestjs/core': '^11.0.0', 'drizzle-orm': '^0.38.3' },
            devDependencies: { vitest: '^2.1.8', eslint: '^9.0.0' },
          }),
        },
      ],
    },
    topLevelDirs: ['src', 'test', 'migrations'],
    entryPoints: ['src/main.ts'],
    glossaryTerms: ['Order', 'Fulfilment', 'Line item'],
  },
  {
    slug: 'nextjs',
    title: 'Next.js',
    blurb: 'React app router, Jest, npm — a front end with its own conventions to respect.',
    repoName: 'acme/storefront',
    sample: {
      fileList: ['package.json', 'tsconfig.json', 'package-lock.json'],
      files: [
        {
          path: 'package.json',
          content: pkg({
            name: 'storefront',
            scripts: { lint: 'next lint', test: 'jest' },
            dependencies: { next: '^15.1.3', react: '^19.0.0' },
            devDependencies: { jest: '^29.0.0', eslint: '^9.0.0' },
          }),
        },
      ],
    },
    topLevelDirs: ['app', 'components', 'lib'],
    entryPoints: ['app/layout.tsx'],
    glossaryTerms: ['Cart', 'Checkout', 'Variant'],
  },
  {
    slug: 'django',
    title: 'Django',
    blurb: 'Python with Poetry and pytest — apps, migrations, and a settings module.',
    repoName: 'acme/billing',
    sample: {
      fileList: ['pyproject.toml', 'poetry.lock'],
      files: [
        {
          path: 'pyproject.toml',
          content: '[tool.poetry.dependencies]\ndjango = "^5.0"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n',
        },
      ],
    },
    topLevelDirs: ['billing', 'invoices', 'tests'],
    entryPoints: ['manage.py'],
    glossaryTerms: ['Invoice', 'Dunning', 'Ledger entry'],
  },
  {
    slug: 'fastapi',
    title: 'FastAPI',
    blurb: 'Python service with uv and pytest — typed routes and Pydantic models.',
    repoName: 'acme/pricing',
    sample: {
      fileList: ['pyproject.toml', 'uv.lock'],
      files: [
        {
          path: 'pyproject.toml',
          content: '[project]\ndependencies = ["fastapi", "pydantic"]\n\n[dependency-groups]\ndev = ["pytest"]\n',
        },
      ],
    },
    topLevelDirs: ['app', 'tests'],
    entryPoints: ['app/main.py'],
    glossaryTerms: ['Price book', 'Tier', 'Quote'],
  },
  {
    slug: 'go',
    title: 'Go',
    blurb: 'Modules, go vet and go test — the verify command specd will actually run.',
    repoName: 'acme/gateway',
    sample: { fileList: ['go.mod', 'go.sum'], files: [{ path: 'go.mod', content: 'module github.com/acme/gateway\n\ngo 1.25\n' }] },
    topLevelDirs: ['cmd', 'internal', 'pkg'],
    entryPoints: ['cmd/gateway/main.go'],
    glossaryTerms: ['Route', 'Upstream', 'Backpressure'],
  },
  {
    slug: 'rust',
    title: 'Rust',
    blurb: 'Cargo with clippy in the verify command — a stricter gate than most.',
    repoName: 'acme/indexer',
    sample: { fileList: ['Cargo.toml', 'Cargo.lock'], files: [{ path: 'Cargo.toml', content: '[package]\nname = "indexer"\nedition = "2021"\n' }] },
    topLevelDirs: ['src', 'benches', 'tests'],
    entryPoints: ['src/main.rs'],
    glossaryTerms: ['Segment', 'Posting list', 'Merge policy'],
  },
  {
    slug: 'rails',
    title: 'Ruby on Rails',
    blurb: 'Bundler and RSpec — conventions the agent should follow rather than reinvent.',
    repoName: 'acme/crm',
    sample: { fileList: ['Gemfile', 'Gemfile.lock'], files: [{ path: 'Gemfile', content: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'rspec-rails', group: :test\n" }] },
    topLevelDirs: ['app', 'config', 'spec'],
    entryPoints: ['config/application.rb'],
    glossaryTerms: ['Contact', 'Pipeline', 'Deal'],
  },
  {
    slug: 'terraform',
    title: 'Terraform',
    blurb: 'Infrastructure, where an unreviewed agent change is least forgiving.',
    repoName: 'acme/platform-infra',
    sample: { fileList: ['main.tf', 'variables.tf', 'outputs.tf'], files: [] },
    topLevelDirs: ['modules', 'environments'],
    entryPoints: ['main.tf'],
    glossaryTerms: ['Workspace', 'Module', 'Remote state'],
  },
];

export interface GalleryPack {
  entry: GalleryEntry;
  stack: DetectedStack;
  /** The one-line summary the templates interpolate as `[detected]`. */
  summary: string;
  agentsMd: string;
  files: ScaffoldFile[];
}

/**
 * Build a gallery page's contents by running the product's own pipeline.
 *
 * The date is passed in rather than read from the clock so a page rendered
 * twice is byte-identical — these are statically generated, and a timestamp
 * that moves would make every build a diff.
 */
export function galleryPack(entry: GalleryEntry, date = '2026-01-01'): GalleryPack {
  const stack = detectStack(entry.sample.files, entry.sample.fileList);
  const projectName = entry.repoName.split('/')[0] ?? 'acme';

  const agentsMd = renderAgentsMd({
    repoName: entry.repoName,
    stack,
    isPrimary: true,
    projectName,
  });

  const files = renderScaffold({
    repoName: entry.repoName,
    projectName,
    isPrimary: true,
    stack,
    topLevelDirs: entry.topLevelDirs,
    entryPoints: entry.entryPoints,
    glossaryTerms: entry.glossaryTerms,
    date,
    agentsMd,
  });

  return { entry, stack, summary: describeStack(stack), agentsMd, files };
}

export function galleryEntry(slug: string): GalleryEntry | undefined {
  return GALLERY.find((e) => e.slug === slug);
}
