import { IGNORED_DIRS, MANIFEST_FILES, type RepoFile } from './vcs.types.js';

/**
 * What a read-only onboarding scan actually opens.
 *
 * The first version of this read seventeen root manifests, which is why the
 * knowledge base it produced was thin: a model that has seen `package.json`
 * and a directory listing can describe a *file tree*, not a system. Everything
 * that makes a repo specifiable — how it is verified in CI, what services it
 * needs to boot, what configuration it takes, what it stores — lives in files
 * the scan never opened, so every one of those sections came back UNVERIFIED.
 *
 * So the net is wider, but it is a *selector*, not a crawler:
 *
 *   - Tiered, so one noisy tier cannot starve the others. A monorepo with 200
 *     `package.json` files still leaves room for the CI workflow.
 *   - Capped per tier and per file, because this content becomes a prompt.
 *   - Deterministic: same tree in, same targets out, in the same order.
 *   - Never sensitive. Widening a net that ships file contents to a model
 *     provider means the filter below is load-bearing, not hygiene.
 */

export interface ScanTarget {
  path: string;
  /** How much of it is worth reading. A CI workflow is not a README. */
  maxBytes: number;
}

/** Full read: these are small, and the model quotes them back as evidence. */
const ROOT_BYTES = 40_000;

interface Tier {
  name: string;
  cap: number;
  maxBytes: number;
  match: (path: string, basename: string, depth: number) => boolean;
}

/** Verification and delivery — the ground truth for runbooks and conventions. */
const CI_FILES = new Set([
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  'Jenkinsfile',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'Procfile',
  'fly.toml',
  'vercel.json',
  'netlify.toml',
  'render.yaml',
  'serverless.yml',
  'skaffold.yaml',
]);

/** Tool configuration — how code is linted, formatted, typed and tested. */
const CONFIG_BASENAMES = new Set([
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yml',
  'biome.json',
  'biome.jsonc',
  '.prettierrc',
  '.prettierrc.json',
  '.editorconfig',
  'ruff.toml',
  '.ruff.toml',
  'setup.cfg',
  'tox.ini',
  'pytest.ini',
  '.golangci.yml',
  '.golangci.yaml',
  'rustfmt.toml',
  'clippy.toml',
  '.rubocop.yml',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.workspace.ts',
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'playwright.config.ts',
  'cypress.config.ts',
  'phpunit.xml',
  'checkstyle.xml',
]);

/** Manifests below the root — the map of a workspace or a polyglot repo. */
const WORKSPACE_MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'composer.json',
  'Gemfile',
  'requirements.txt',
]);

/** Where the data model is declared, in the shapes people declare it in. */
const SCHEMA_BASENAMES = new Set([
  'schema.prisma',
  'schema.rb',
  'schema.sql',
  'schema.ts',
  'schema.py',
  'models.py',
  'models.ts',
  'entities.ts',
  'alembic.ini',
  'init.sql',
]);

const DOC_DIRS = new Set(['docs', 'doc', 'adr', 'rfcs', 'design']);

/** Files whose contents must never leave the repository, however they match. */
const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.staging',
  '.env.test',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'terraform.tfvars',
]);

const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.crt'];

/**
 * A committed `.env.example` documents configuration; a committed `.env` is an
 * accident, and the scan refuses to be the thing that copies it into a prompt.
 */
export function isSensitivePath(path: string): boolean {
  const base = basenameOf(path);
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  // `.env.<anything>` unless it is explicitly a sample.
  if (base.startsWith('.env.') && !/\.(example|sample|template|dist)$/.test(base)) return true;
  return false;
}

const TIERS: Tier[] = [
  {
    name: 'ci',
    cap: 5,
    maxBytes: 8_000,
    match: (path, base) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
      CI_FILES.has(path) ||
      base.startsWith('Dockerfile') ||
      /^(docker-)?compose\.[^/]*ya?ml$/.test(base),
  },
  {
    name: 'config',
    cap: 8,
    maxBytes: 4_000,
    match: (_path, base, depth) => depth <= 2 && CONFIG_BASENAMES.has(base),
  },
  {
    name: 'workspace',
    cap: 12,
    maxBytes: 6_000,
    match: (path, base, depth) => depth > 1 && depth <= 4 && WORKSPACE_MANIFESTS.has(base) && !path.includes('/test'),
  },
  {
    name: 'data',
    cap: 6,
    maxBytes: 12_000,
    match: (path, base) =>
      SCHEMA_BASENAMES.has(base) ||
      (/\/(migrations|migrate|db|database)\//.test(`/${path}`) && /\.(sql|ts|py|rb)$/.test(base)),
  },
  {
    name: 'docs',
    cap: 6,
    maxBytes: 12_000,
    match: (path, base, depth) =>
      depth <= 3 && base.endsWith('.md') && DOC_DIRS.has(path.split('/')[0] ?? ''),
  },
  {
    name: 'entry',
    cap: 6,
    maxBytes: 6_000,
    match: (path, base, depth) =>
      depth <= 3 &&
      /^(main|index|app|server|application|manage|cli)\.(ts|tsx|js|mjs|py|go|rs|rb|java|kt)$/.test(base) &&
      !path.startsWith('test'),
  },
];

/**
 * The files an onboarding scan should open, in priority order.
 *
 * Root manifests first (they set the stack every other read is interpreted
 * against), then each tier up to its cap.
 */
export function selectScanTargets(files: string[]): ScanTarget[] {
  const visible = files.filter(
    (path) => !path.split('/').some((seg) => IGNORED_DIRS.has(seg)) && !isSensitivePath(path),
  );

  const roots = new Set(MANIFEST_FILES);
  const chosen = new Map<string, ScanTarget>();

  for (const path of visible) {
    if (roots.has(path)) chosen.set(path, { path, maxBytes: ROOT_BYTES });
  }

  // Shallow before deep, then alphabetical: `apps/api/package.json` is worth
  // more than `apps/api/src/fixtures/package.json`, and a stable order keeps
  // two scans of an unchanged repo byte-identical.
  const ranked = [...visible].sort(
    (a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b),
  );

  for (const tier of TIERS) {
    let taken = 0;
    for (const path of ranked) {
      if (taken >= tier.cap) break;
      if (chosen.has(path)) continue;
      if (!tier.match(path, basenameOf(path), depthOf(path))) continue;
      chosen.set(path, { path, maxBytes: tier.maxBytes });
      taken += 1;
    }
  }

  return [...chosen.values()];
}

/**
 * Reads the selected targets with a small amount of concurrency.
 *
 * Sequential reads were fine for seventeen files; at fifty they are the
 * slowest part of onboarding on a hosted provider, where every file is its own
 * REST round trip. Eight at a time is well inside any rate limit and turns
 * that into about a second.
 */
export async function collectSamples(
  files: string[],
  read: (target: ScanTarget) => Promise<RepoFile | null>,
  concurrency = 8,
): Promise<RepoFile[]> {
  const targets = selectScanTargets(files);
  const out: (RepoFile | null)[] = new Array(targets.length).fill(null);

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    for (let i = next++; i < targets.length; i = next++) {
      const target = targets[i]!;
      try {
        const file = await read(target);
        out[i] = file ? { ...file, content: file.content.slice(0, target.maxBytes) } : null;
      } catch {
        // A file we cannot read is one we do not report on. A scan that dies
        // on a single unreadable blob would fail onboarding outright.
        out[i] = null;
      }
    }
  });

  await Promise.all(workers);
  return out.filter((f): f is RepoFile => f !== null);
}

function basenameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

function depthOf(path: string): number {
  return path.split('/').length;
}
