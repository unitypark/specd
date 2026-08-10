/**
 * Grade symbol extraction for languages the TypeScript compiler cannot judge.
 *
 * Each language gets an oracle written in its own toolchain — `go/ast` for Go,
 * `ast` for Python — so no oracle shares an assumption with the line-based
 * extractor it grades. Both are subprocesses reading paths on stdin, which is
 * the cheapest possible interface and keeps the oracle honest: it cannot
 * accidentally import the thing it is grading.
 *
 * Either language is skipped, loudly, when its toolchain is missing or the
 * corpus holds no files of that kind. A score computed over zero files is 100%
 * and means nothing, and reporting it would be exactly the dishonesty this
 * harness exists to avoid.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSymbols } from '../apps/api/src/knowledge/symbols.js';

const oracleDir = resolve(dirname(fileURLToPath(import.meta.url)), 'oracles');

export interface LanguageScore {
  language: string;
  files: number;
  oracleSymbols: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositives: string[];
  falseNegatives: string[];
}

/** Absent toolchain or empty corpus — reported, never scored. */
export interface LanguageSkip {
  language: string;
  skipped: string;
}

export type LanguageResult = LanguageScore | LanguageSkip;

export const isSkip = (r: LanguageResult): r is LanguageSkip => 'skipped' in r;

function available(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Ask an oracle what a set of files declares. */
function runOracle(
  command: string,
  args: string[],
  files: string[],
  cwd: string,
): Record<string, string[]> {
  const stdout = execFileSync(command, args, {
    cwd,
    input: `${files.join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // The oracle's own stderr is its skip log; let it through so a file the
    // toolchain refused is visible rather than silently absent.
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return JSON.parse(stdout) as Record<string, string[]>;
}

function grade(
  language: string,
  files: string[],
  byFile: Record<string, string[]>,
  target: string,
): LanguageScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];

  for (const file of files) {
    // Fair file set: only files the oracle actually graded. One that failed to
    // parse is out for both sides, not a free win for either.
    const truth = byFile[file];
    if (!truth) continue;

    const oracle = new Set(truth);
    const mine = new Set(
      extractSymbols(file, readFileSync(join(target, file), 'utf8')).map((s) => s.qualifiedName),
    );

    for (const name of mine) {
      if (oracle.has(name)) tp += 1;
      else {
        fp += 1;
        falsePositives.push(`${file}: ${name}`);
      }
    }
    for (const name of oracle) {
      if (!mine.has(name)) {
        fn += 1;
        falseNegatives.push(`${file}: ${name}`);
      }
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return {
    language,
    files: files.filter((f) => byFile[f]).length,
    oracleSymbols: tp + fn,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    falsePositives: falsePositives.slice(0, 10),
    falseNegatives: falseNegatives.slice(0, 10),
  };
}

export function gradeGo(files: string[], target: string): LanguageResult {
  if (files.length === 0) return { language: 'go', skipped: 'no .go files in this corpus' };
  if (!available('go', ['version'])) return { language: 'go', skipped: 'go is not on PATH' };

  const byFile = runOracle('go', ['run', join(oracleDir, 'go_oracle.go')], files, target);
  return grade('go', files, byFile, target);
}

export function gradePython(files: string[], target: string): LanguageResult {
  if (files.length === 0) return { language: 'python', skipped: 'no .py files in this corpus' };
  if (!available('python3', ['--version'])) {
    return { language: 'python', skipped: 'python3 is not on PATH' };
  }

  const byFile = runOracle('python3', [join(oracleDir, 'python_oracle.py')], files, target);
  return grade('python', files, byFile, target);
}
