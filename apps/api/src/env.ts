import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the monorepo-root `.env` before `Config` reads `process.env` — `pnpm
 * dev` runs straight from the shell, and nothing else in this project sources
 * it. A missing file is not an error here: it means `Config`'s own
 * `required()` checks, which name the exact variable and say what to do about
 * it, are what the developer should see instead of a raw ENOENT.
 *
 * Shared, because the seeds are entry points too and were the reason
 * `pnpm db:seed` needed a DATABASE_URL exported by hand.
 */
export function loadRootEnv(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  try {
    process.loadEnvFile(join(root, '.env'));
  } catch {
    // No .env yet (or it could not be read) — required() below says so.
  }
}
