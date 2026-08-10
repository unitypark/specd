/**
 * Eval runner.
 *
 * Not part of `pnpm test`. These grade quality rather than assert behaviour:
 * the number moves when the corpus moves, and a suite that fails because
 * someone wrote an unusual class is a suite people learn to ignore. The tests
 * hold the invariants; this holds the score.
 *
 *   pnpm eval                      # this repository
 *   pnpm eval --target ../other    # any checkout you point it at
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gradeAll } from './symbols.eval.js';
import { specForPath } from '../apps/api/src/knowledge/symbols.js';

const args = process.argv.slice(2);
const at = args.indexOf('--target');
const target = resolve(at === -1 ? process.cwd() : (args[at + 1] ?? process.cwd()));

const tracked = execFileSync('git', ['ls-files'], { cwd: target, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

// TypeScript only: the oracle is the TypeScript compiler, so it is the only
// language it can grade. Go and Python are ungraded until each has an oracle
// of its own — which is the honest state, not a passing one.
const files = tracked
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
  .filter((f) => specForPath(f) !== null)
  .map((f) => join(target, f));

if (files.length === 0) {
  console.error(`no TypeScript files under ${target}`);
  process.exit(1);
}

const score = gradeAll(files);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log(`\nsymbol extraction vs the TypeScript compiler`);
console.log(`target      ${target}`);
console.log(`files       ${score.files}`);
console.log(`oracle says ${score.oracleSymbols} declarations`);
console.log(`precision   ${pct(score.precision)}   (what we report that is real)`);
console.log(`recall      ${pct(score.recall)}   (what is real that we report)`);
console.log(`f1          ${pct(score.f1)}`);

if (score.worstFalsePositives.length) {
  console.log(`\nreported but not real:`);
  for (const s of score.worstFalsePositives) console.log(`  + ${s}`);
}
if (score.worstFalseNegatives.length) {
  console.log(`\nreal but missed:`);
  for (const s of score.worstFalseNegatives) console.log(`  - ${s}`);
}

const out = join(process.cwd(), 'evals/results/symbols.json');
writeFileSync(out, `${JSON.stringify({ target, ...score }, null, 2)}\n`);
console.log(`\nwritten to ${out}\n`);
