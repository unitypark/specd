import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner. Plain SQL files applied in filename order, tracked in
 * `_specd_migrations` — the schema needs pgvector extensions, generated
 * tsvector columns and partial unique indexes that a schema-diff tool cannot
 * express, so the SQL is authored rather than generated.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

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

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _specd_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM _specd_migrations`).map((r) => r.name),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(join(migrationsDir, file), 'utf8');
      process.stdout.write(`→ ${file}\n`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _specd_migrations (name) VALUES (${file})`;
      });
      ran += 1;
    }

    console.log(ran === 0 ? 'Database already up to date.' : `Applied ${ran} migration(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
