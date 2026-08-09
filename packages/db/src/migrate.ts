import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner. Plain SQL files applied in filename order, tracked in
 * `_specd_migrations` — the schema needs pgvector extensions, generated
 * tsvector columns and partial unique indexes that a schema-diff tool cannot
 * express, so the SQL is authored rather than generated.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

/**
 * Apply every migration this package ships that the target database has not
 * seen, in filename order, each in its own transaction.
 *
 * Exported separately from `main()` so it can be pointed at a throwaway
 * database and run from zero — the path a real deployment takes, and the one
 * that never happens locally, where the schema arrives one migration at a
 * time as they are written.
 */
export async function migrate(url: string): Promise<{ applied: string[] }> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _specd_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const already = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM _specd_migrations`).map((r) => r.name),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      if (already.has(file)) continue;
      const body = readFileSync(join(migrationsDir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _specd_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }

    return { applied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  // Load the monorepo-root .env before reading DATABASE_URL — pnpm db:migrate
  // runs straight from the shell, and nothing else in this project sources
  // it. A missing .env just falls through to the check below, unchanged.
  try {
    process.loadEnvFile(join(here, '..', '..', '..', '.env'));
  } catch {
    // No .env yet, or it could not be read.
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const { applied } = await migrate(url);
  for (const file of applied) process.stdout.write(`→ ${file}\n`);
  console.log(
    applied.length === 0 ? 'Database already up to date.' : `Applied ${applied.length} migration(s).`,
  );
}

// Only migrate when run as a script. Without this guard, importing `migrate`
// — which the tests do, to point it at a throwaway database — would silently
// migrate whatever DATABASE_URL happens to be in the environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
