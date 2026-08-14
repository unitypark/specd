#!/usr/bin/env node
/**
 * `pnpm demo` — from a clean clone to a specd you can click on.
 *
 * Evaluating specd used to mean: read the README, copy .env, start Postgres,
 * remember to wait for it, run migrations, run a seed that produced a
 * directory rather than a project, start two dev servers, then complete a
 * setup wizard before seeing whether completing it was worth it. Every step is
 * documented and every step is a place to stop.
 *
 * This is the same steps in order, with the waiting handled and each one
 * saying what it is doing — so a failure names the step that failed instead of
 * arriving as a stack trace three steps later.
 *
 * It runs the dev servers deliberately. specd is pre-1.0 and local-first;
 * `knowledge/runbooks/deploy.md` is honest that no production topology is
 * chosen yet, and shipping a Dockerfile here would quietly answer a question
 * this repository has not answered.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false, ...opts });

function step(n, what) {
  process.stdout.write(`\n[${n}/6] ${what}\n`);
}

function die(what) {
  process.stderr.write(`\n${what}\n`);
  process.exit(1);
}

step(1, 'Configuration');
if (existsSync(join(root, '.env'))) {
  console.log('.env is already here — leaving it alone.');
} else {
  copyFileSync(join(root, '.env.example'), join(root, '.env'));
  console.log('.env created from .env.example. The dev defaults work as they are.');
}

// `@specd/db` and `@specd/shared` are consumed through their `dist/`, which is
// gitignored and which nothing builds at install time — so a clean clone has
// no `dist` at all, and a clone that has merely been pulled has yesterday's.
// The web app does not notice: Next transpiles `@specd/shared` from source.
// The API does, and it fails at import, before it can listen. That is the
// worst shape this failure could take — `pnpm dev` keeps running, the web app
// compiles and serves, and every request it makes goes nowhere.
step(2, 'Workspace packages');
if (run('pnpm', ['--filter', './packages/*', 'build']).status !== 0) {
  die('Could not build the workspace packages.');
}

step(3, 'Postgres');
if (run('docker', ['compose', 'up', '-d', 'postgres']).status !== 0) {
  die('Could not start Postgres. Is Docker running?');
}

// Compose returns as soon as the container is created; the database accepts
// connections a little later. Migrating into that gap is the failure this
// script exists to stop someone hitting on their first try.
process.stdout.write('waiting for it to accept connections');
let ready = false;
for (let i = 0; i < 60; i += 1) {
  const probe = run('docker', ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'specd'], {
    stdio: 'ignore',
  });
  if (probe.status === 0) {
    ready = true;
    break;
  }
  process.stdout.write('.');
  spawnSync('sleep', ['1']);
}
process.stdout.write('\n');
if (!ready) die('Postgres did not become ready in 60s. `docker compose logs postgres` says why.');

step(4, 'Schema');
if (run('pnpm', ['db:migrate']).status !== 0) die('Migrations failed.');

step(5, 'A project to look at');
if (run('pnpm', ['seed:demo']).status !== 0) die('Seeding failed.');

step(6, 'The app');
console.log('Starting the API and the web app. Ctrl-C stops both.\n');
const dev = spawn('pnpm', ['dev'], { cwd: root, stdio: 'inherit' });
dev.on('exit', (code) => process.exit(code ?? 0));
