import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { createDb, projects, repositories, users, memberships } from '@specd/db';
import { eq, sql } from 'drizzle-orm';
import { loadRootEnv } from './env.js';
import { seedFixtureRepository } from './seed.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Everything needed to open specd and see it working.
 *
 * `seed.ts` builds a fixture repository on disk; this puts a person and a
 * project in the database and connects the two. The gap between them was the
 * whole friction: a first run landed on an empty wizard, and evaluating the
 * product meant completing setup before seeing whether setup was worth
 * completing.
 *
 * Deliberately stops short of grounding the repository. Running the onboarding
 * agent needs a model credential this script has no business assuming, and
 * *watching* Ground read a real repository is the most interesting thing specd
 * does — pre-baking it would hide the demo's best moment. The last line says
 * exactly which button produces it.
 *
 * Idempotent: re-running adopts what is already there rather than failing on a
 * unique index, because the second thing anyone does with a demo is run it
 * again.
 */

const DEMO = {
  email: 'demo@specd.dev',
  password: 'specd-demo',
  name: 'Demo Reviewer',
  slug: 'aurora',
  project: 'Aurora CRM',
} as const;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function main(): Promise<void> {
  loadRootEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const fixture = await seedFixtureRepository();
  const handle = createDb(databaseUrl, { max: 2 });

  try {
    const [existingUser] = await handle.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${DEMO.email})`)
      .limit(1);

    const user =
      existingUser ??
      (
        await handle.db
          .insert(users)
          .values({
            email: DEMO.email,
            name: DEMO.name,
            passwordHash: await hashPassword(DEMO.password),
          })
          .returning()
      )[0]!;

    const [existingProject] = await handle.db
      .select()
      .from(projects)
      .where(eq(projects.slug, DEMO.slug))
      .limit(1);

    const project =
      existingProject ??
      (
        await handle.db
          .insert(projects)
          .values({
            slug: DEMO.slug,
            name: DEMO.project,
            description: 'A fixture CRM service, for trying specd out.',
            // The wizard sets this when setup finishes. A demo project that
            // looks half-configured would send someone back through setup.
            setupCompletedAt: new Date(),
          })
          .returning()
      )[0]!;

    await handle.db
      .insert(memberships)
      .values({ userId: user.id, projectId: project.id, role: 'owner' })
      .onConflictDoNothing();

    const [existingRepo] = await handle.db
      .select()
      .from(repositories)
      .where(eq(repositories.projectId, project.id))
      .limit(1);

    if (!existingRepo) {
      await handle.db.insert(repositories).values({
        projectId: project.id,
        provider: 'local',
        name: 'aurora-api',
        localPath: fixture.path,
        defaultBranch: fixture.branch,
        isPrimary: true,
      });
    }

    console.log('\nspecd is ready to look at.\n');
    console.log(`  http://localhost:3000/p/${DEMO.slug}/board`);
    console.log(`  sign in as ${DEMO.email} / ${DEMO.password}\n`);
    console.log(`Connected repository: ${fixture.path}`);
    console.log(
      'Nothing is grounded yet, on purpose — watching Ground read a real repository is\n' +
        'the most interesting thing specd does. Press "Ground" on the repositories tab.\n' +
        'It needs an AI credential; without one it still writes the scanned half.\n',
    );
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
