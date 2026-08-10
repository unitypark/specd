/**
 * Tier-1 symbol extraction: what a file declares, and where.
 *
 * Declarative and line-based, not a parser. That is a deliberate tier, the
 * same shape the benchmarked engine uses for languages it has no grammar for
 * (per knowledge/research/code-graph-rag-engine-analysis.md#8-the-clever-parts,
 * "a new language is one YAML file"). It buys top-level declarations across
 * any language for the cost of a few patterns and no new dependency — the
 * TypeScript compiler is a devDependency, and promoting a 20 MB compiler to a
 * runtime dependency to find `export class` is not a trade worth making yet.
 *
 * It is honest about its ceiling: declarations only, no scope analysis, no
 * types, no call graph. A real parser per language is the upgrade path, and
 * the record it produces here is shaped so that swapping one in changes the
 * producer and nothing downstream.
 */

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'method' | 'const';

export interface ExtractedSymbol {
  kind: SymbolKind;
  name: string;
  /** `Class.method` where a parent is known, otherwise the bare name. */
  qualifiedName: string;
  line: number;
  exported: boolean;
}

interface Rule {
  kind: SymbolKind;
  re: RegExp;
  /** Container for the members that follow, when this declaration opens one. */
  opensScope?: boolean;
}

interface LanguageSpec {
  extensions: string[];
  rules: Rule[];
  /** Members indented under an open scope, e.g. TypeScript class methods. */
  memberRule?: Rule;
  lineComment: string;
}

const TS: LanguageSpec = {
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  rules: [
    { kind: 'class', re: /^(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, opensScope: true },
    { kind: 'interface', re: /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/, opensScope: true },
    { kind: 'function', re: /^(export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'type', re: /^(export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  ],
  // Two spaces in, an identifier, an open paren: a class member. Deliberately
  // strict — anything looser starts matching calls inside function bodies.
  memberRule: {
    kind: 'method',
    re: /^ {2}(?:(?:public|private|protected|readonly|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/,
  },
  lineComment: '//',
};

const GO: LanguageSpec = {
  extensions: ['.go'],
  rules: [
    // Receiver methods carry their type, which is Go's own qualified name.
    { kind: 'method', re: /^func\s+\([^)]*?([A-Za-z_][\w]*)\s*\)\s*([A-Za-z_][\w]*)/ },
    { kind: 'function', re: /^func\s+([A-Za-z_][\w]*)/ },
    { kind: 'type', re: /^type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/ },
    { kind: 'const', re: /^(?:const|var)\s+([A-Za-z_][\w]*)/ },
  ],
  lineComment: '//',
};

const PY: LanguageSpec = {
  extensions: ['.py'],
  rules: [
    { kind: 'class', re: /^class\s+([A-Za-z_][\w]*)/, opensScope: true },
    { kind: 'function', re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  ],
  memberRule: { kind: 'method', re: /^ {4}(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
  lineComment: '#',
};

const LANGUAGES = [TS, GO, PY];

export function specForPath(path: string): LanguageSpec | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot);
  return LANGUAGES.find((l) => l.extensions.includes(ext)) ?? null;
}

/** Languages symbol extraction understands, for the docs and the run log. */
export const SYMBOL_EXTENSIONS = LANGUAGES.flatMap((l) => l.extensions);

/**
 * Declarations in one file.
 *
 * Go's receiver methods produce `Type.Method` from the declaration itself;
 * TypeScript and Python get theirs from the most recent scope-opening
 * declaration, which is why the member rules are indentation-anchored rather
 * than brace-aware. A member is only attributed to a parent that is still the
 * nearest one above it.
 */
export function extractSymbols(path: string, content: string): ExtractedSymbol[] {
  const spec = specForPath(path);
  if (!spec) return [];

  const out: ExtractedSymbol[] = [];
  let scope: string | null = null;
  let inBlockComment = false;

  const lines = content.split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // Block comments would otherwise turn documentation examples into
    // declarations — this file's own header being a good example.
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (line.trimStart().startsWith(spec.lineComment) || line.trimStart().startsWith('*')) continue;

    let matched = false;
    for (const rule of spec.rules) {
      const m = rule.re.exec(line);
      if (!m) continue;

      // Go's receiver rule captures the type first, then the method name.
      const isGoMethod = rule.kind === 'method' && m.length > 2 && m[2] !== undefined && !m[1]?.includes('export');
      const name = isGoMethod ? m[2]! : (m[2] ?? m[1])!;
      const parent = isGoMethod ? m[1]! : null;

      out.push({
        kind: rule.kind,
        name,
        qualifiedName: parent ? `${parent}.${name}` : name,
        line: i + 1,
        exported: isGoMethod
          ? /^[A-Z]/.test(name)
          : spec === GO
            ? /^[A-Z]/.test(name)
            : Boolean(m[1]),
      });
      if (rule.opensScope) scope = name;
      matched = true;
      break;
    }
    if (matched) continue;

    if (spec.memberRule && scope) {
      const m = spec.memberRule.re.exec(line);
      // Reserved words read as members otherwise: `if (`, `for (`, `return (`.
      if (m?.[1] && !RESERVED.has(m[1])) {
        out.push({
          kind: 'method',
          name: m[1],
          qualifiedName: `${scope}.${m[1]}`,
          line: i + 1,
          exported: !m[1].startsWith('_') && !m[1].startsWith('#'),
        });
      }
    }
  }

  return out;
}

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'typeof', 'await',
  'constructor', 'super', 'this', 'else', 'do', 'try', 'new', 'delete', 'void',
]);
