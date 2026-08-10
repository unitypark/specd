import { readFileSync } from 'node:fs';

/**
 * Fail a CI run whose tests were skipped rather than passed.
 *
 * Every suite that needs Postgres skips itself when none is reachable. That is
 * deliberate — it keeps `pnpm test` green on a laptop with no infra — and it
 * makes a green CI run ambiguous: 24 skipped and 24 passed both exit zero and
 * both look fine at a glance.
 *
 * Two failure modes produce the skip, and this catches both: no database, and
 * a suite whose own `beforeAll` throws — which is what happens when a test
 * fake falls behind the interface a real adapter grew, twice in one week.
 */
const [reportPath] = process.argv.slice(2);

if (!reportPath) {
  console.error('usage: check-no-skips.mjs <vitest-json-report>');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  console.error(`Could not read the vitest report at ${reportPath}: ${err.message}`);
  console.error('The test step should have written it — did it fail before finishing?');
  process.exit(1);
}

const pending = report.numPendingTests ?? 0;
const passed = report.numPassedTests ?? 0;

if (pending > 0) {
  console.error(`${pending} test(s) were skipped, and this run needed them.`);
  console.error(
    'Either Postgres was unreachable, or a suite failed in beforeAll — vitest reports both as skipped.',
  );
  process.exit(1);
}

if (passed === 0) {
  console.error('No tests ran at all. That is not a pass.');
  process.exit(1);
}

console.log(`${passed} tests ran, none skipped.`);
