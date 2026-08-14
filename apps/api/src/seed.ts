import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * Seeds a working local fixture: a git repository that looks like a real
 * NestJS service, so the onboarding agent has something honest to scan and
 * the whole loop can be exercised without connecting a customer's code.
 *
 * Creates ./.specd-work/fixtures/aurora-api (gitignored).
 */

const FIXTURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'aurora-api',
      version: '1.4.0',
      private: true,
      packageManager: 'pnpm@10.0.0',
      scripts: {
        build: 'nest build',
        start: 'nest start',
        lint: 'eslint src',
        typecheck: 'tsc --noEmit',
        test: 'jest',
      },
      dependencies: {
        '@nestjs/common': '^11.0.0',
        '@nestjs/core': '^11.0.0',
        '@nestjs/typeorm': '^11.0.0',
        typeorm: '^0.3.20',
        pg: '^8.13.0',
        bullmq: '^5.34.0',
      },
      devDependencies: {
        '@types/jest': '^29.5.0',
        eslint: '^9.17.0',
        jest: '^29.7.0',
        typescript: '^5.7.0',
      },
    },
    null,
    2,
  ),

  'tsconfig.json': JSON.stringify(
    { compilerOptions: { target: 'ES2023', module: 'commonjs', strict: true, outDir: 'dist' } },
    null,
    2,
  ),

  'README.md': `# Aurora CRM — API

The customer-facing CRM backend. Contacts, deals, activities, and the
integrations that keep them in sync with the rest of the business.

## Modules

- \`contacts\` — contact records, tags, dedupe and merge
- \`deals\` — pipeline stages, deal values, forecast rollups
- \`activities\` — calls, emails and meetings attached to contacts and deals
- \`events\` — the outbox worker that delivers webhooks to integration partners
- \`auth\` — workspace-scoped authentication and session handling

## Running it

\`\`\`
pnpm install
pnpm start
\`\`\`

Requires Postgres 16 and Redis.
`,

  'src/main.ts': `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
`,

  'src/app.module.ts': `import { Module } from '@nestjs/common';
import { ContactsModule } from './contacts/contacts.module';
import { DealsModule } from './deals/deals.module';
import { ActivitiesModule } from './activities/activities.module';
import { EventsModule } from './events/events.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [AuthModule, ContactsModule, DealsModule, ActivitiesModule, EventsModule],
})
export class AppModule {}
`,

  'src/contacts/contacts.service.ts': `import { Injectable } from '@nestjs/common';

/**
 * Contacts are workspace-scoped. Every query goes through the list-query
 * builder so filters behave identically in the grid, in exports and in the API.
 */
@Injectable()
export class ContactsService {
  async list(workspaceId: string, filters: ContactFilters) {
    return this.queryBuilder(workspaceId, filters).getMany();
  }

  async merge(survivorId: string, duplicateId: string) {
    // Reassigns activities, deals and tags to the survivor atomically.
    throw new Error('not implemented');
  }
}

export interface ContactFilters {
  search?: string;
  tagIds?: string[];
  ownerId?: string;
  createdAfter?: Date;
}
`,

  'src/deals/deals.service.ts': `import { Injectable } from '@nestjs/common';

@Injectable()
export class DealsService {
  async advanceStage(dealId: string, stage: DealStage) {
    // Stage transitions are audited; forecast rollups recompute on write.
  }
}

export type DealStage = 'lead' | 'qualified' | 'proposal' | 'won' | 'lost';
`,

  'src/events/outbox.worker.ts': `import { Injectable } from '@nestjs/common';

/**
 * Outbox worker. Integration partners receive webhooks from here — never
 * inline in the request path, so a slow partner cannot slow a user down.
 */
@Injectable()
export class OutboxWorker {
  async deliver(eventId: string) {
    // Retries with exponential backoff; poison events must not amplify.
  }
}
`,

  'src/auth/auth.service.ts': `import { Injectable } from '@nestjs/common';

/**
 * Auth facade. Strategies register behind it so the rest of the app never
 * depends on how a session was established.
 */
@Injectable()
export class AuthService {
  async signIn(email: string, password: string) {
    throw new Error('not implemented');
  }

  async refresh(refreshToken: string) {
    throw new Error('not implemented');
  }
}
`,

  'src/auth/local.strategy.ts': `export class LocalStrategy {
  // Email + password, workspace-scoped.
}
`,

  '.eslintrc.json': JSON.stringify({ extends: ['eslint:recommended'] }, null, 2),

  'test/contacts.e2e-spec.ts': `describe('contacts', () => {
  it('lists contacts for a workspace', async () => {
    // ...
  });
});
`,
};

export async function seedFixtureRepository(): Promise<{ path: string; branch: string }> {
  const root = resolve(process.cwd(), '../../.specd-work/fixtures/aurora-api');
  await mkdir(root, { recursive: true });

  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  const git = simpleGit({ baseDir: root });

  // `checkIsRepo()` walks up, and this fixture lives inside the specd repo —
  // so ask whether *this* directory is the top level, not whether some
  // ancestor is.
  const isOwnRepo = await git
    .revparse(['--show-toplevel'])
    .then((top) => resolve(top.trim()) === root)
    .catch(() => false);

  if (!isOwnRepo) {
    await git.init();
    await git.addConfig('user.name', 'specd seed');
    await git.addConfig('user.email', 'seed@specd.dev');
  }

  await git.add('.');
  const status = await git.status();
  if (status.staged.length > 0) {
    await git.commit('Initial Aurora CRM API');
  }

  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() || 'main';
  return { path: root, branch };
}

// Still runnable on its own: `pnpm db:seed` builds the fixture and says where
// it is, for anyone wiring it up by hand rather than through `pnpm demo`.
if (process.argv[1]?.endsWith('seed.ts')) {
  seedFixtureRepository()
    .then(({ path }) => {
      console.log(`Fixture repository ready at:\n  ${path}\n`);
      console.log('Register it with:');
      console.log('  POST /api/projects/<slug>/repositories');
      console.log(`  { "provider": "local", "name": "aurora-api", "localPath": "${path}" }`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
