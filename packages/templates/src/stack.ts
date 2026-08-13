/**
 * Stack detection. The onboarding agent gets a factual starting point before
 * it reads a single line of prose — everything the templates interpolate as
 * `[detected]` comes from here, not from the model.
 */

export interface DetectedStack {
  language: string;
  framework?: string;
  packageManager?: string;
  testRunner?: string;
  verifyCommand?: string;
  linter?: string;
  extras: string[];
}

export interface RepoFileSample {
  path: string;
  content: string;
}

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  packageManager?: string;
}

/**
 * Detects the stack from a handful of manifest files. Deliberately
 * conservative: anything it cannot see, it leaves out rather than guessing —
 * a wrong "[detected]" line is worse than a missing one (§15 credibility).
 */
export function detectStack(files: RepoFileSample[], fileList: string[]): DetectedStack {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const has = (p: string) => fileList.includes(p) || byPath.has(p);
  const extras: string[] = [];

  const pkgRaw = byPath.get('package.json');
  if (pkgRaw !== undefined || files.some((f) => f.path.endsWith('/package.json'))) {
    let pkg: PackageJsonLike = {};
    try {
      pkg = JSON.parse(pkgRaw ?? '{}') as PackageJsonLike;
    } catch {
      // A malformed package.json is the repo's problem, not a reason to crash.
    }

    // In a workspace the root manifest is a task runner: the framework, the
    // test runner and the ORM are all declared one level down. Reading only
    // the root is how a NestJS monorepo used to come back "JavaScript, no
    // framework" — a wrong [detected] line, which is worse than none (§15).
    const deps: Record<string, string> = {};
    for (const file of files) {
      if (!file.path.endsWith('package.json')) continue;
      try {
        const parsed = JSON.parse(file.content) as PackageJsonLike;
        Object.assign(deps, parsed.dependencies, parsed.devDependencies);
      } catch {
        // Same reasoning as above, one workspace at a time.
      }
    }
    const dep = (name: string) => name in deps;

    const framework = dep('@nestjs/core')
      ? 'NestJS'
      : dep('next')
        ? 'Next.js'
        : dep('react')
          ? 'React'
          : dep('express')
            ? 'Express'
            : dep('fastify')
              ? 'Fastify'
              : undefined;

    const testRunner = dep('vitest')
      ? 'Vitest'
      : dep('jest')
        ? 'Jest'
        : dep('mocha')
          ? 'Mocha'
          : undefined;

    const packageManager = pkg.packageManager?.split('@')[0]
      ?? (has('pnpm-lock.yaml')
        ? 'pnpm'
        : has('yarn.lock')
          ? 'yarn'
          : has('bun.lockb')
            ? 'bun'
            : has('package-lock.json')
              ? 'npm'
              : undefined);

    const linter = dep('eslint') ? 'ESLint' : dep('biome') || dep('@biomejs/biome') ? 'Biome' : undefined;

    const scripts = pkg.scripts ?? {};
    const pm = packageManager ?? 'npm';
    const verifyParts: string[] = [];
    if (scripts.lint) verifyParts.push(`${pm} lint`);
    if (scripts.typecheck) verifyParts.push(`${pm} typecheck`);
    if (scripts.test) verifyParts.push(`${pm} test`);

    if (dep('drizzle-orm')) extras.push('Drizzle ORM');
    if (dep('prisma') || dep('@prisma/client')) extras.push('Prisma');
    if (dep('typeorm')) extras.push('TypeORM');
    if (dep('mongoose')) extras.push('MongoDB/Mongoose');
    if (dep('bullmq')) extras.push('BullMQ');

    const typescript =
      has('tsconfig.json') ||
      has('tsconfig.base.json') ||
      fileList.some((f) => f.endsWith('.ts') || f.endsWith('.tsx')) ||
      dep('typescript');

    return {
      language: typescript ? 'TypeScript' : 'JavaScript',
      framework,
      packageManager,
      testRunner,
      linter,
      verifyCommand: verifyParts.length ? verifyParts.join(' && ') : undefined,
      extras,
    };
  }

  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    const pyproject = byPath.get('pyproject.toml') ?? '';
    const framework = /django/i.test(pyproject)
      ? 'Django'
      : /fastapi/i.test(pyproject)
        ? 'FastAPI'
        : /flask/i.test(pyproject)
          ? 'Flask'
          : undefined;
    return {
      language: 'Python',
      framework,
      packageManager: has('poetry.lock') ? 'poetry' : has('uv.lock') ? 'uv' : 'pip',
      testRunner: /pytest/i.test(pyproject) ? 'pytest' : undefined,
      verifyCommand: /pytest/i.test(pyproject) ? 'pytest' : undefined,
      extras,
    };
  }

  if (has('go.mod')) {
    return {
      language: 'Go',
      packageManager: 'go modules',
      testRunner: 'go test',
      verifyCommand: 'go vet ./... && go test ./...',
      extras,
    };
  }

  if (has('Cargo.toml')) {
    return {
      language: 'Rust',
      packageManager: 'cargo',
      testRunner: 'cargo test',
      verifyCommand: 'cargo clippy && cargo test',
      extras,
    };
  }

  if (has('Gemfile')) {
    return {
      language: 'Ruby',
      framework: /rails/i.test(byPath.get('Gemfile') ?? '') ? 'Rails' : undefined,
      packageManager: 'bundler',
      testRunner: 'RSpec',
      verifyCommand: 'bundle exec rspec',
      extras,
    };
  }

  if (fileList.some((f) => f.endsWith('.tf'))) {
    return { language: 'Terraform', verifyCommand: 'terraform validate', extras };
  }

  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    return {
      language: 'Java/Kotlin',
      packageManager: has('pom.xml') ? 'Maven' : 'Gradle',
      verifyCommand: has('pom.xml') ? 'mvn verify' : './gradlew check',
      extras,
    };
  }

  return { language: 'unknown', extras };
}

export function describeStack(stack: DetectedStack): string {
  return [stack.framework, stack.language, stack.packageManager, stack.testRunner, ...stack.extras]
    .filter(Boolean)
    .join(' · ');
}
