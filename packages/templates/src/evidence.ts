import type { RepoFileSample } from './stack.js';

/**
 * The evidence pack — everything about a repository that can be *read* rather
 * than inferred.
 *
 * This exists because of the failure mode the generated knowledge base kept
 * hitting: a doc whose every interesting section said UNVERIFIED. The scan had
 * the answers sitting in files it never opened. A CI workflow states the verify
 * command. A compose file states what has to be running before the app boots.
 * `.env.example` states the configuration surface. A schema states the nouns.
 *
 * None of that is inference, so none of it is marked UNVERIFIED, and none of it
 * costs a model call. The model's job shrinks to what only judgement can do:
 * why the boundaries are where they are, what the rules behind the code style
 * are, what the domain words mean.
 *
 * Every fact carries the path it came from, because a fact a reader cannot
 * check is worth about as much as a guess.
 */

export interface CommandFact {
  name: string;
  command: string;
  /** The file this was read out of. */
  source: string;
}

export interface WorkspaceFact {
  path: string;
  name?: string;
  scripts: string[];
}

export interface CiFact {
  path: string;
  name?: string;
  triggers: string[];
  /** The commands the pipeline actually runs, in order, deduplicated. */
  commands: string[];
}

export interface ServiceFact {
  name: string;
  image?: string;
  ports: string[];
  source: string;
}

export interface EnvVarFact {
  name: string;
  /** The comment sitting above it, which is usually the only documentation. */
  note?: string;
  source: string;
}

export interface EntityFact {
  name: string;
  source: string;
}

export interface IntegrationFact {
  name: string;
  evidence: string;
}

export interface TestEvidence {
  /** Directories holding the most test files, most first. */
  dirs: string[];
  fileCount: number;
  /** Naming shapes actually in use: `*.test.ts`, `test_*.py`, `*_test.go`. */
  patterns: string[];
  frameworks: string[];
}

export interface ModuleFact {
  path: string;
  files: number;
  /** The extension that dominates the directory — a crude but honest label. */
  kind?: string;
}

export interface RepoEvidence {
  /** Runnable commands declared by the repo itself. */
  scripts: CommandFact[];
  workspaces: WorkspaceFact[];
  ci: CiFact[];
  services: ServiceFact[];
  envVars: EnvVarFact[];
  entities: EntityFact[];
  /** Where state lives: engines, ORMs, migration directories. */
  dataStores: string[];
  integrations: IntegrationFact[];
  tests: TestEvidence;
  /** Documentation the repo already has, which onboarding must not duplicate. */
  docs: string[];
  /** Agent instruction files already present — a signal to merge, not overwrite. */
  existingAgentDocs: string[];
  modules: ModuleFact[];
  entryPoints: string[];
  migrationDirs: string[];
  languages: { language: string; files: number }[];
  fileCount: number;
}

export function collectEvidence(input: {
  files: string[];
  samples: RepoFileSample[];
}): RepoEvidence {
  const { files, samples } = input;
  const byPath = new Map(samples.map((s) => [s.path, s.content]));

  const envVars = readEnvExample(byPath);
  const services = readComposeServices(byPath);
  const deps = allDependencies(byPath);

  return {
    scripts: readScripts(byPath),
    workspaces: readWorkspaces(byPath),
    ci: readCi(byPath),
    services,
    envVars,
    entities: readEntities(byPath),
    dataStores: readDataStores({ deps, services, envVars, files }),
    integrations: readIntegrations({ deps, envVars }),
    tests: readTests(files, deps, byPath),
    docs: files.filter(isExistingDoc).slice(0, 20),
    existingAgentDocs: AGENT_DOCS.filter((p) => files.includes(p)),
    modules: readModules(files),
    entryPoints: readEntryPoints(files),
    migrationDirs: readMigrationDirs(files),
    languages: readLanguages(files),
    fileCount: files.length,
  };
}

/** True when there is enough here to write a data-model doc worth reading. */
export function hasDataEvidence(evidence: RepoEvidence): boolean {
  return (
    evidence.entities.length > 0 ||
    evidence.migrationDirs.length > 0 ||
    evidence.dataStores.length > 0
  );
}

/** True when the repo demonstrably talks to something outside itself. */
export function hasIntegrationEvidence(evidence: RepoEvidence): boolean {
  return evidence.integrations.length > 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function readScripts(byPath: Map<string, string>): CommandFact[] {
  const out: CommandFact[] = [];

  const pkg = parseJson(byPath.get('package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const pm = packageManagerOf(pkg, byPath);
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    out.push({ name: `${pm} ${name}`, command, source: 'package.json' });
  }

  for (const [path, pattern] of [
    ['Makefile', /^([a-zA-Z][\w.-]*):(?!=)/gm],
    ['justfile', /^([a-zA-Z][\w-]*)(?:\s+[\w\s]*)?:(?!=)/gm],
  ] as const) {
    const content = byPath.get(path);
    if (!content) continue;
    for (const match of content.matchAll(pattern)) {
      const target = match[1]!;
      if (target === '.PHONY') continue;
      out.push({
        name: path === 'Makefile' ? `make ${target}` : `just ${target}`,
        command: `(target in ${path})`,
        source: path,
      });
    }
  }

  const pyproject = byPath.get('pyproject.toml');
  if (pyproject) {
    for (const match of pyproject.matchAll(/^\[tool\.(poe|taskipy)\.tasks\]\n([\s\S]*?)(?=\n\[|$)/gm)) {
      for (const line of (match[2] ?? '').split('\n')) {
        const kv = /^([\w.-]+)\s*=\s*"(.+)"/.exec(line.trim());
        if (kv) out.push({ name: kv[1]!, command: kv[2]!, source: 'pyproject.toml' });
      }
    }
  }

  return out.slice(0, 40);
}

function packageManagerOf(pkg: JsonObject | null, byPath: Map<string, string>): string {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
  if (declared) return declared;
  if (byPath.has('pnpm-workspace.yaml')) return 'pnpm';
  return 'npm';
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

function readWorkspaces(byPath: Map<string, string>): WorkspaceFact[] {
  const out: WorkspaceFact[] = [];

  for (const [path, content] of byPath) {
    if (path === 'package.json' || !path.endsWith('/package.json')) continue;
    const pkg = parseJson(content);
    out.push({
      path: path.replace(/\/package\.json$/, ''),
      name: typeof pkg?.name === 'string' ? pkg.name : undefined,
      scripts: Object.keys((pkg?.scripts ?? {}) as Record<string, string>).slice(0, 8),
    });
  }

  for (const [path, content] of byPath) {
    if (path === 'go.mod' || !path.endsWith('/go.mod')) continue;
    const module = /^module\s+(\S+)/m.exec(content)?.[1];
    out.push({ path: path.replace(/\/go\.mod$/, ''), name: module, scripts: [] });
  }

  for (const [path, content] of byPath) {
    if (path === 'pyproject.toml' || !path.endsWith('/pyproject.toml')) continue;
    const name = /^name\s*=\s*"([^"]+)"/m.exec(content)?.[1];
    out.push({ path: path.replace(/\/pyproject\.toml$/, ''), name, scripts: [] });
  }

  return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 20);
}

// ---------------------------------------------------------------------------
// CI — the one place a repo states, unambiguously, how it is verified
// ---------------------------------------------------------------------------

function readCi(byPath: Map<string, string>): CiFact[] {
  const out: CiFact[] = [];

  for (const [path, content] of byPath) {
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) {
      out.push({
        path,
        // `[^\S\n]` and not `\s`: `\s` crosses newlines, so a key with no
        // value on its line silently captures the next line's key instead.
        name: /^name:[^\S\n]*(.+)$/m.exec(content)?.[1]?.trim().replace(/^["']|["']$/g, ''),
        triggers: readWorkflowTriggers(content),
        commands: readRunCommands(content, /^\s*(?:-\s*)?run:\s*(.*)$/gm),
      });
      continue;
    }

    if (path === '.gitlab-ci.yml' || path === '.gitlab-ci.yaml') {
      out.push({
        path,
        triggers: [],
        commands: readRunCommands(content, /^\s*(?:-\s+)(.*)$/gm, /^\s*(script|before_script):/),
      });
    }
  }

  return out.slice(0, 6);
}

function readWorkflowTriggers(content: string): string[] {
  const on = /^on:[^\S\n]*(.*)$/m.exec(content);
  if (!on) return [];
  if (on[1]?.trim()) {
    return on[1]
      .replace(/[[\]]/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Block form: the keys indented under `on:` up to the next top-level key.
  const block = content.slice(on.index + on[0].length).split(/\n(?=\S)/)[0] ?? '';
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]!).slice(0, 6);
}

/**
 * The commands a pipeline runs. Multi-line `run: |` blocks keep their first
 * line only — enough to recognise the step, short enough to stay a table row.
 */
function readRunCommands(content: string, pattern: RegExp, sectionGuard?: RegExp): string[] {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  let inSection = !sectionGuard;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (sectionGuard) {
      if (sectionGuard.test(line)) inSection = true;
      else if (/^\s{0,2}\S+:/.test(line) && !/^\s*-/.test(line)) inSection = false;
      if (!inSection) continue;
    }

    pattern.lastIndex = 0;
    const match = pattern.exec(line);
    if (!match) continue;

    let command = (match[1] ?? '').trim();
    if (command === '|' || command === '>' || command === '|-') {
      command = (lines[i + 1] ?? '').trim();
    }
    // A shell continuation is one command, not a command and a dangling `\`.
    for (let j = i + 1; command.endsWith('\\') && j < lines.length && j < i + 6; j++) {
      command = `${command.slice(0, -1).trim()} ${(lines[j] ?? '').trim()}`;
    }
    command = command.replace(/^["']|["']$/g, '').trim();
    if (!command || command.startsWith('#') || command.length > 160) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    out.push(command);
  }

  return out.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Runtime dependencies — what has to be up before the thing boots
// ---------------------------------------------------------------------------

function readComposeServices(byPath: Map<string, string>): ServiceFact[] {
  const out: ServiceFact[] = [];

  for (const path of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml']) {
    const content = byPath.get(path);
    if (!content) continue;

    const lines = content.split('\n');
    let inServices = false;
    let current: ServiceFact | null = null;

    for (const line of lines) {
      if (/^services:\s*$/.test(line)) {
        inServices = true;
        continue;
      }
      if (inServices && /^\S/.test(line)) {
        inServices = false;
        if (current) out.push(current);
        current = null;
        continue;
      }
      if (!inServices) continue;

      const service = /^\s{2}([\w.-]+):\s*$/.exec(line);
      if (service) {
        if (current) out.push(current);
        current = { name: service[1]!, ports: [], source: path };
        continue;
      }
      if (!current) continue;

      const image = /^\s+image:\s*(.+)$/.exec(line);
      if (image) current.image = image[1]!.trim().replace(/^["']|["']$/g, '');

      const port = /^\s+-\s*["']?(\d+:\d+)/.exec(line);
      if (port) current.ports.push(port[1]!);
    }
    if (current) out.push(current);
  }

  return out.slice(0, 12);
}

function readEnvExample(byPath: Map<string, string>): EnvVarFact[] {
  const out: EnvVarFact[] = [];

  for (const path of ['.env.example', '.env.sample', '.env.template']) {
    const content = byPath.get(path);
    if (!content) continue;

    let block: string[] = [];
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line) {
        block = [];
        continue;
      }
      if (line.startsWith('#')) {
        // The whole contiguous comment block, joined: these comments wrap
        // across lines, and either end of one line alone is half a sentence.
        // Decorative rules (`# ─── AI ───`) keep only their label.
        const stripped = line.replace(/^#+\s*/, '');
        const rule = /[─–—=*_-]{3,}/.test(stripped);
        const text = stripped
          .replace(/[─–—=*_-]{3,}/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        // A section rule keeps its label but stays visibly a heading, so the
        // note reads "AI — the onboarding agent…" rather than running together.
        if (text) block.push(rule ? `${text} —` : text);
        continue;
      }
      const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
      if (match) {
        const note = block.join(' ').trim();
        out.push({ name: match[1]!, note: note ? note.slice(0, 240) : undefined, source: path });
        block = [];
      }
    }
  }

  return out.slice(0, 60);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const ENTITY_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:pg|sqlite|mysql)Table\(\s*['"]([\w.]+)['"]/g, label: 'Drizzle' },
  { pattern: /^model\s+(\w+)\s*\{/gm, label: 'Prisma' },
  { pattern: /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+["`]?([\w.]+)["`]?/gi, label: 'SQL' },
  { pattern: /^\s*create_table\s+["'](\w+)["']/gm, label: 'Rails' },
  { pattern: /^class\s+(\w+)\(models\.Model\)/gm, label: 'Django' },
  { pattern: /__tablename__\s*=\s*['"](\w+)['"]/g, label: 'SQLAlchemy' },
  { pattern: /@Entity\(\s*['"]?(\w+)?/g, label: 'TypeORM' },
];

function readEntities(byPath: Map<string, string>): EntityFact[] {
  const seen = new Map<string, string>();

  for (const [path, content] of byPath) {
    if (!/\.(ts|js|sql|prisma|rb|py)$/.test(path)) continue;
    for (const { pattern } of ENTITY_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const name = match[1];
        if (!name || name.length > 40) continue;
        if (!seen.has(name)) seen.set(name, path);
      }
    }
  }

  return [...seen.entries()].map(([name, source]) => ({ name, source })).slice(0, 40);
}

function readDataStores(input: {
  deps: Set<string>;
  services: ServiceFact[];
  envVars: EnvVarFact[];
  files: string[];
}): string[] {
  const { deps, services, envVars, files } = input;
  const out = new Set<string>();

  const ORMS: [string, string][] = [
    ['drizzle-orm', 'Drizzle ORM'],
    ['@prisma/client', 'Prisma'],
    ['prisma', 'Prisma'],
    ['typeorm', 'TypeORM'],
    ['sequelize', 'Sequelize'],
    ['mongoose', 'Mongoose (MongoDB)'],
    ['sqlalchemy', 'SQLAlchemy'],
    ['django', 'Django ORM'],
    ['gorm.io/gorm', 'GORM'],
    ['diesel', 'Diesel'],
    ['activerecord', 'ActiveRecord'],
  ];
  for (const [dep, label] of ORMS) if (deps.has(dep)) out.add(label);

  const IMAGES: [RegExp, string][] = [
    [/postgres|pgvector|timescale/i, 'PostgreSQL'],
    [/mysql|mariadb/i, 'MySQL/MariaDB'],
    [/redis|valkey/i, 'Redis'],
    [/mongo/i, 'MongoDB'],
    [/elasticsearch|opensearch/i, 'Elasticsearch/OpenSearch'],
    [/clickhouse/i, 'ClickHouse'],
    [/kafka|redpanda/i, 'Kafka'],
    [/minio|localstack/i, 'S3-compatible object storage'],
  ];
  for (const service of services) {
    for (const [pattern, label] of IMAGES) {
      if (pattern.test(service.image ?? service.name)) out.add(`${label} (${service.source})`);
    }
  }

  for (const env of envVars) {
    if (/^DATABASE_URL$|_DATABASE_URL$/.test(env.name)) out.add('a database URL in configuration');
    if (/REDIS_URL/.test(env.name)) out.add('Redis (configuration)');
    if (/S3_|BUCKET/.test(env.name)) out.add('object storage (configuration)');
  }

  if (files.some((f) => /(^|\/)migrations?\//.test(f))) out.add('SQL migrations in the repo');

  return [...out].slice(0, 12);
}

function readMigrationDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const match = /^(.*(?:migrations?|migrate))\//.exec(file);
    if (match?.[1]) dirs.add(match[1]);
  }
  return [...dirs].sort().slice(0, 6);
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

const KNOWN_SDKS: [string, string][] = [
  ['stripe', 'Stripe'],
  ['@stripe/stripe-js', 'Stripe'],
  ['@anthropic-ai/sdk', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['@aws-sdk/client-s3', 'AWS S3'],
  ['aws-sdk', 'AWS'],
  ['boto3', 'AWS'],
  ['@google-cloud/storage', 'Google Cloud Storage'],
  ['@azure/identity', 'Azure'],
  ['@octokit/rest', 'GitHub API'],
  ['octokit', 'GitHub API'],
  ['@slack/web-api', 'Slack'],
  ['twilio', 'Twilio'],
  ['@sendgrid/mail', 'SendGrid'],
  ['nodemailer', 'SMTP email'],
  ['resend', 'Resend'],
  ['@sentry/node', 'Sentry'],
  ['sentry-sdk', 'Sentry'],
  ['datadog', 'Datadog'],
  ['posthog-node', 'PostHog'],
  ['@supabase/supabase-js', 'Supabase'],
  ['firebase-admin', 'Firebase'],
  ['auth0', 'Auth0'],
  ['next-auth', 'NextAuth'],
  ['@clerk/nextjs', 'Clerk'],
  ['passport', 'Passport auth'],
  ['bullmq', 'BullMQ queues'],
  ['celery', 'Celery'],
  ['kafkajs', 'Kafka'],
  ['amqplib', 'RabbitMQ'],
  ['elastic', 'Elasticsearch'],
  ['algoliasearch', 'Algolia'],
];

/** Words that name a mechanism, a scope or the app itself — never a supplier. */
const NOT_VENDORS = new Set([
  'JWT',
  'SESSION',
  'COOKIE',
  'CSRF',
  'ENCRYPTION',
  'VAULT',
  'ADMIN',
  'APP',
  'API',
  'AUTH',
  'WEBHOOK',
  'ACCESS',
  'REFRESH',
  'SIGNING',
  'MASTER',
  'INTERNAL',
  'SERVICE',
  'CLIENT',
  'SERVER',
  'TEST',
  'DEV',
  'LOCAL',
  'DEFAULT',
]);

function readIntegrations(input: { deps: Set<string>; envVars: EnvVarFact[] }): IntegrationFact[] {
  const out = new Map<string, string>();

  for (const [dep, label] of KNOWN_SDKS) {
    if (input.deps.has(dep)) out.set(label, `dependency \`${dep}\``);
  }

  for (const env of input.envVars) {
    if (!/_(API_KEY|TOKEN|SECRET|WEBHOOK_SECRET|CLIENT_ID)$/.test(env.name)) continue;
    const vendor = env.name.replace(/_(API_KEY|WEBHOOK_SECRET|TOKEN|SECRET|CLIENT_ID)$/, '');
    // `JWT_SECRET` is a secret, not a supplier. Naming your own signing key as
    // a third party in the integrations table is the kind of confident wrong
    // row that costs a reader their trust in the other four.
    if (!vendor || NOT_VENDORS.has(vendor)) continue;
    const label = titleCase(vendor.replace(/_/g, ' '));
    if (!label || out.has(label)) continue;
    out.set(label, `\`${env.name}\` in ${env.source}`);
  }

  return [...out.entries()].map(([name, evidence]) => ({ name, evidence })).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Tests, modules, languages
// ---------------------------------------------------------------------------

const TEST_PATTERNS: [RegExp, string][] = [
  [/\.(test|spec)\.[jt]sx?$/, '*.test.ts / *.spec.ts'],
  [/(^|\/)test_[^/]+\.py$/, 'test_*.py'],
  [/_test\.py$/, '*_test.py'],
  [/_test\.go$/, '*_test.go'],
  [/_spec\.rb$/, '*_spec.rb'],
  [/(^|\/)(tests?|spec|__tests__)\//, 'tests/ directory'],
  [/Test\.java$/, '*Test.java'],
];

function readTests(files: string[], deps: Set<string>, byPath: Map<string, string>): TestEvidence {
  const patterns = new Set<string>();
  const dirCounts = new Map<string, number>();
  let fileCount = 0;

  for (const file of files) {
    const matched = TEST_PATTERNS.filter(([pattern]) => pattern.test(file));
    if (matched.length === 0) continue;
    fileCount += 1;
    for (const [, label] of matched) patterns.add(label);
    const dir = file.split('/').slice(0, -1).join('/') || '.';
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }

  const FRAMEWORKS: [string, string][] = [
    ['vitest', 'Vitest'],
    ['jest', 'Jest'],
    ['mocha', 'Mocha'],
    ['@playwright/test', 'Playwright'],
    ['cypress', 'Cypress'],
    ['pytest', 'pytest'],
    ['rspec-rails', 'RSpec'],
    ['testify', 'testify'],
  ];
  const frameworks = FRAMEWORKS.filter(([dep]) => deps.has(dep)).map(([, label]) => label);
  if (byPath.has('pytest.ini') || /\[tool\.pytest/.test(byPath.get('pyproject.toml') ?? '')) {
    if (!frameworks.includes('pytest')) frameworks.push('pytest');
  }
  if (files.some((f) => f.endsWith('_test.go')) && !frameworks.includes('go test')) {
    frameworks.push('go test');
  }

  const dirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([dir]) => dir);

  return { dirs, fileCount, patterns: [...patterns], frameworks };
}

const CODE_EXTENSIONS = new Map<string, string>([
  ['ts', 'TypeScript'],
  ['tsx', 'TypeScript (React)'],
  ['js', 'JavaScript'],
  ['jsx', 'JavaScript (React)'],
  ['py', 'Python'],
  ['go', 'Go'],
  ['rs', 'Rust'],
  ['rb', 'Ruby'],
  ['java', 'Java'],
  ['kt', 'Kotlin'],
  ['php', 'PHP'],
  ['cs', 'C#'],
  ['swift', 'Swift'],
  ['tf', 'Terraform'],
  ['sql', 'SQL'],
]);

function readModules(files: string[]): ModuleFact[] {
  const counts = new Map<string, number>();
  const kinds = new Map<string, Map<string, number>>();

  for (const file of files) {
    if (!file.includes('/')) continue;
    const parts = file.split('/');
    // Two levels deep: `apps/api` says more than `apps`, and stops well short
    // of listing every leaf directory in the repository.
    for (const depth of [1, 2]) {
      if (parts.length <= depth) continue;
      const dir = parts.slice(0, depth).join('/');
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
      const ext = parts.at(-1)!.split('.').pop() ?? '';
      if (!CODE_EXTENSIONS.has(ext)) continue;
      const byKind = kinds.get(dir) ?? new Map<string, number>();
      byKind.set(ext, (byKind.get(ext) ?? 0) + 1);
      kinds.set(dir, byKind);
    }
  }

  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([path, files]) => {
      const dominant = [...(kinds.get(path) ?? new Map())].sort((a, b) => b[1] - a[1])[0];
      return { path, files, kind: dominant ? CODE_EXTENSIONS.get(dominant[0]) : undefined };
    });
}

function readLanguages(files: string[]): { language: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = file.split('.').pop() ?? '';
    const language = CODE_EXTENSIONS.get(ext);
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([language, files]) => ({ language, files }));
}

const ENTRY_CANDIDATES = [
  /^(src\/)?main\.(ts|js|py|go|rs)$/,
  /^(src\/)?index\.(ts|js)$/,
  /^(src\/)?app\.(ts|tsx|js|py)$/,
  /^app\/(layout|page)\.tsx$/,
  /^cmd\/[\w-]+\/main\.go$/,
  /^manage\.py$/,
  /^config\/application\.rb$/,
  /^apps\/[\w-]+\/src\/main\.(ts|js)$/,
  /^[\w-]+\/main\.(ts|go|py)$/,
];

function readEntryPoints(files: string[]): string[] {
  return files.filter((f) => ENTRY_CANDIDATES.some((c) => c.test(f))).slice(0, 8);
}

const AGENT_DOCS = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md'];

function isExistingDoc(path: string): boolean {
  if (AGENT_DOCS.includes(path)) return false;
  if (/^(README|CONTRIBUTING|ARCHITECTURE|SECURITY|CHANGELOG)\.(md|rst)$/i.test(path)) return true;
  return /^(docs?|adr|rfcs|design)\/.+\.md$/i.test(path);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function parseJson(raw: string | undefined): JsonObject | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonObject) : null;
  } catch {
    // A malformed manifest is the repo's problem, not a reason to crash.
    return null;
  }
}

/** Every dependency named anywhere in the scan, normalised to lowercase. */
function allDependencies(byPath: Map<string, string>): Set<string> {
  const out = new Set<string>();

  for (const [path, content] of byPath) {
    if (path.endsWith('package.json')) {
      const pkg = parseJson(content);
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const block = pkg?.[key];
        if (typeof block !== 'object' || block === null) continue;
        for (const name of Object.keys(block as JsonObject)) out.add(name.toLowerCase());
      }
      continue;
    }

    if (path.endsWith('pyproject.toml') || path.endsWith('requirements.txt')) {
      for (const match of content.matchAll(/^["']?([A-Za-z][\w.-]{1,40})(?=[\s"'=<>~[\]]|$)/gm)) {
        out.add(match[1]!.toLowerCase());
      }
      continue;
    }

    if (path.endsWith('go.mod') || path.endsWith('Gemfile') || path.endsWith('Cargo.toml')) {
      for (const match of content.matchAll(/^\s*(?:require\s+|gem\s+["'])?([\w./-]{3,60})/gm)) {
        out.add(match[1]!.toLowerCase());
      }
    }
  }

  return out;
}

function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
