/**
 * Grade symbol extraction against an independent oracle.
 *
 * The extractor is declarative and line-based by design (0014) — it trades
 * exactness for costing no runtime dependency. That trade is only defensible
 * if someone measures what it actually costs, and the only honest way to
 * measure is against an implementation that shares none of its assumptions.
 *
 * The oracle is the TypeScript compiler. It is a devDependency, which is
 * exactly why it was rejected as the extractor — a 20 MB compiler in the API's
 * runtime closure to find `export class` — and exactly why it is the right
 * grader: independent, exact, and free here because this never ships.
 *
 * Both sides are held to the same file set, so neither can win by looking at
 * files the other did not (the "fair file set" rule from
 * knowledge/research/code-graph-rag-engine-analysis.md#7-the-clever-parts).
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { extractSymbols } from '../apps/api/src/knowledge/symbols.js';

export interface Graded {
  file: string;
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
}

/**
 * What the compiler says a file declares, in the extractor's own vocabulary.
 *
 * Restricted to the declaration shapes the extractor claims to find: comparing
 * against everything a real parser can see would measure the gap between a
 * tier and a compiler, which is already known and is not the question.
 */
export function oracleSymbols(file: string, source: string): Set<string> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();

  const visitMembers = (parent: string, members: ts.NodeArray<ts.ClassElement | ts.TypeElement>) => {
    for (const m of members) {
      if (!m.name || !ts.isIdentifier(m.name)) continue;
      const isMethodish =
        ts.isMethodDeclaration(m) ||
        ts.isMethodSignature(m) ||
        ts.isGetAccessor(m) ||
        ts.isSetAccessor(m);
      if (isMethodish) out.add(`${parent}.${m.name.text}`);
    }
  };

  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name) {
      out.add(st.name.text);
      visitMembers(st.name.text, st.members);
    } else if (ts.isInterfaceDeclaration(st)) {
      out.add(st.name.text);
      // Correction against the oracle, found by its own first run: an
      // interface's method signatures are declarations, and omitting them
      // scored the extractor down for finding something real.
      visitMembers(st.name.text, st.members);
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      out.add(st.name.text);
    } else if (ts.isTypeAliasDeclaration(st)) {
      out.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
      }
    }
  }
  return out;
}

export function gradeFile(file: string, source: string): Graded {
  const oracle = oracleSymbols(file, source);
  const mine = new Set(extractSymbols(file, source).map((s) => s.qualifiedName));

  return {
    file,
    truePositives: [...mine].filter((s) => oracle.has(s)),
    falsePositives: [...mine].filter((s) => !oracle.has(s)),
    falseNegatives: [...oracle].filter((s) => !mine.has(s)),
  };
}

export interface Score {
  files: number;
  oracleSymbols: number;
  precision: number;
  recall: number;
  f1: number;
  worstFalsePositives: string[];
  worstFalseNegatives: string[];
}

export function gradeAll(files: string[]): Score {
  const graded = files.map((f) => gradeFile(f, readFileSync(f, 'utf8')));

  const tp = graded.reduce((n, g) => n + g.truePositives.length, 0);
  const fp = graded.reduce((n, g) => n + g.falsePositives.length, 0);
  const fn = graded.reduce((n, g) => n + g.falseNegatives.length, 0);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

  const tally = (pick: (g: Graded) => string[]) => {
    const counts = new Map<string, number>();
    for (const g of graded) for (const s of pick(g)) counts.set(s, (counts.get(s) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([s, n]) => `${s} ×${n}`);
  };

  return {
    files: files.length,
    oracleSymbols: tp + fn,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    worstFalsePositives: tally((g) => g.falsePositives),
    worstFalseNegatives: tally((g) => g.falseNegatives),
  };
}
