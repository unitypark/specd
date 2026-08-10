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
import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gradeAll } from './symbols.eval.js';
import { gradeGo, gradePython, isSkip } from './native-oracles.eval.js';
import { specForPath } from '../apps/api/src/knowledge/symbols.js';

const args = process.argv.slice(2);
const at = args.indexOf('--target');
const target = resolve(at === -1 ? process.cwd() : (args[at + 1] ?? process.cwd()));

/**
 * Files to grade. `git ls-files` where the target is a checkout — it respects
 * .gitignore for free — and a plain walk where it is not, so an external
 * corpus like a language's own standard library can be graded without being
 * turned into a repository first. That path is how the stdlib numbers in
 * README.md were produced, and it is what makes them reproducible.
 */
function listFiles(root: string): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
        const full = join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [relative(root, full)];
      });
    return walk(root);
  }
}

const tracked = listFiles(target);

const files = tracked
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
  .filter((f) => specForPath(f) !== null)
  .map((f) => join(target, f));

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log(`\ntarget      ${target}`);

// Each language is graded only if the corpus has any of it. A corpus of one
// language is a normal thing to point this at — a language's own standard
// library, say — and the other graders should say "nothing here" rather than
// the run failing.
const score = files.length === 0 ? null : gradeAll(files);
if (!score) {
  console.log(`\ntypescript — skipped: no .ts/.tsx files in this corpus`);
} else {
  console.log(`\nsymbol extraction vs the TypeScript compiler`);
  console.log(`files       ${score.files}`);
  console.log(`oracle says ${score.oracleSymbols} declarations`);
  console.log(`precision   ${pct(score.precision)}   (what we report that is real)`);
  console.log(`recall      ${pct(score.recall)}   (what is real that we report)`);
  console.log(`f1          ${pct(score.f1)}`);

  if (score.worstFalsePositives.length) {
    console.log(`  reported but not real:`);
    for (const s of score.worstFalsePositives) console.log(`    + ${s}`);
  }
  if (score.worstFalseNegatives.length) {
    console.log(`  real but missed:`);
    for (const s of score.worstFalseNegatives) console.log(`    - ${s}`);
  }
}

// ─── go and python ───────────────────────────────────────────────────────────
// Each graded by an oracle written in its own toolchain, so no oracle shares
// an assumption with the extractor it grades.
const native = [
  gradeGo(tracked.filter((f) => f.endsWith('.go')), target),
  gradePython(tracked.filter((f) => f.endsWith('.py')), target),
];

for (const result of native) {
  console.log('');
  if (isSkip(result)) {
    console.log(`${result.language} — skipped: ${result.skipped}`);
    continue;
  }
  console.log(`symbol extraction vs the ${result.language} toolchain`);
  console.log(`files       ${result.files}`);
  console.log(`oracle says ${result.oracleSymbols} declarations`);
  console.log(`precision   ${pct(result.precision)}`);
  console.log(`recall      ${pct(result.recall)}`);
  console.log(`f1          ${pct(result.f1)}`);
  if (result.falsePositives.length) {
    console.log(`  reported but not real:`);
    for (const s of result.falsePositives) console.log(`    + ${s}`);
  }
  if (result.falseNegatives.length) {
    console.log(`  real but missed:`);
    for (const s of result.falseNegatives) console.log(`    - ${s}`);
  }
}

const out = join(process.cwd(), 'evals/results/symbols.json');
writeFileSync(out, `${JSON.stringify({ target, typescript: score, native }, null, 2)}\n`);
console.log(`\nwritten to ${out}\n`);

// ─── retrieval ───────────────────────────────────────────────────────────────
// Needs a database, so it is reported as skipped rather than failing when
// there is none — an eval that cannot run should say so, not look like a zero.
async function retrieval(): Promise<void> {
  const { scoreRetrieval } = await import('./retrieval.eval.js');
  const r = await scoreRetrieval();
  console.log(`retrieval over ${r.questions} labelled questions`);
  console.log(`recall      ${pct(r.recall)}   (answer doc returned at all)`);
  console.log(`recall@3    ${pct(r.recallAt3)}`);
  console.log(`mrr         ${r.mrr.toFixed(3)}`);
  if (r.misses.length) {
    console.log(`\nmissed:`);
    for (const m of r.misses) console.log(`  · ${m}`);
  }
  writeFileSync(join(process.cwd(), 'evals/results/retrieval.json'), `${JSON.stringify(r, null, 2)}\n`);
  console.log('');
}

if (at === -1) {
  retrieval().catch((err: unknown) => {
    console.log(`\nretrieval eval skipped: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}
