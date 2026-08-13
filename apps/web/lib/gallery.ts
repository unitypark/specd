import {
  collectEvidence,
  describeStack,
  detectStack,
  renderAgentsMd,
  renderScaffold,
  scaffoldDocPaths,
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
  /**
   * A plausible file tree for a repo of this kind. The evidence pass runs over
   * it exactly as it would over a real scan, so the page shows the modules,
   * tests and conditional docs this shape would actually earn.
   */
  tree: string[];
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
    tree: [
      'src/main.ts',
      'src/orders/orders.controller.ts',
      'src/orders/orders.service.ts',
      'src/orders/orders.service.test.ts',
      'src/fulfilment/fulfilment.service.ts',
      'src/fulfilment/fulfilment.service.test.ts',
      'src/db/schema.ts',
      'migrations/0001_init.sql',
      'test/orders.e2e.test.ts',
      '.github/workflows/ci.yml',
      'docker-compose.yml',
      '.env.example',
    ],
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
    tree: [
      'app/layout.tsx',
      'app/page.tsx',
      'app/cart/page.tsx',
      'app/checkout/page.tsx',
      'components/CartLine.tsx',
      'components/CartLine.test.tsx',
      'lib/pricing.ts',
      'lib/pricing.test.ts',
      '.github/workflows/ci.yml',
    ],
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
    tree: [
      'manage.py',
      'billing/settings.py',
      'billing/urls.py',
      'invoices/models.py',
      'invoices/views.py',
      'invoices/migrations/0001_initial.py',
      'tests/test_invoices.py',
      'tests/test_dunning.py',
    ],
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
    tree: [
      'app/main.py',
      'app/models.py',
      'app/routers/quotes.py',
      'app/routers/tiers.py',
      'tests/test_quotes.py',
    ],
  },
  {
    slug: 'go',
    title: 'Go',
    blurb: 'Modules, go vet and go test — the verify command specd will actually run.',
    repoName: 'acme/gateway',
    sample: { fileList: ['go.mod', 'go.sum'], files: [{ path: 'go.mod', content: 'module github.com/acme/gateway\n\ngo 1.25\n' }] },
    tree: [
      'cmd/gateway/main.go',
      'internal/router/router.go',
      'internal/router/router_test.go',
      'internal/upstream/pool.go',
      'internal/upstream/pool_test.go',
      'pkg/backpressure/limiter.go',
    ],
  },
  {
    slug: 'rust',
    title: 'Rust',
    blurb: 'Cargo with clippy in the verify command — a stricter gate than most.',
    repoName: 'acme/indexer',
    sample: { fileList: ['Cargo.toml', 'Cargo.lock'], files: [{ path: 'Cargo.toml', content: '[package]\nname = "indexer"\nedition = "2021"\n' }] },
    tree: [
      'src/main.rs',
      'src/segment.rs',
      'src/posting_list.rs',
      'src/merge_policy.rs',
      'benches/index.rs',
      'tests/segment.rs',
    ],
  },
  {
    slug: 'rails',
    title: 'Ruby on Rails',
    blurb: 'Bundler and RSpec — conventions the agent should follow rather than reinvent.',
    repoName: 'acme/crm',
    sample: { fileList: ['Gemfile', 'Gemfile.lock'], files: [{ path: 'Gemfile', content: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'rspec-rails', group: :test\n" }] },
    tree: [
      'config/application.rb',
      'app/models/contact.rb',
      'app/models/deal.rb',
      'app/controllers/deals_controller.rb',
      'db/schema.rb',
      'db/migrate/20260101_create_deals.rb',
      'spec/models/deal_spec.rb',
    ],
  },
  {
    slug: 'terraform',
    title: 'Terraform',
    blurb: 'Infrastructure, where an unreviewed agent change is least forgiving.',
    repoName: 'acme/platform-infra',
    sample: { fileList: ['main.tf', 'variables.tf', 'outputs.tf'], files: [] },
    tree: [
      'main.tf',
      'variables.tf',
      'outputs.tf',
      'modules/network/main.tf',
      'modules/database/main.tf',
      'environments/prod/main.tf',
      'environments/staging/main.tf',
    ],
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

  // The same evidence pass a real scan runs, over the entry's own file list —
  // so a gallery page shows the scaffold this repo shape would really get,
  // conditional docs and all.
  const evidence = collectEvidence({
    files: [...new Set([...entry.sample.fileList, ...entry.tree])],
    samples: entry.sample.files,
  });

  const agentsMd = renderAgentsMd({
    repoName: entry.repoName,
    stack,
    isPrimary: true,
    projectName,
    docs: scaffoldDocPaths(evidence),
  });

  const files = renderScaffold({
    repoName: entry.repoName,
    projectName,
    isPrimary: true,
    stack,
    evidence,
    date,
    agentsMd,
  });

  return { entry, stack, summary: describeStack(stack), agentsMd, files };
}

export function galleryEntry(slug: string): GalleryEntry | undefined {
  return GALLERY.find((e) => e.slug === slug);
}
