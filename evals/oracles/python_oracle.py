"""Independent oracle for Python symbol extraction.

Uses the standard library's `ast` module — the interpreter's own parser — so
it shares no assumption with the line-based extractor it grades. Reads
newline-separated file paths on stdin, writes {"path": ["qualifiedName", ...]}
to stdout.

Restricted to the declaration shapes the extractor claims to find: top-level
classes, top-level functions, and methods as Class.method. Grading against
everything a real parser can see would measure the distance between a tier and
an interpreter, which is already known and is not the question.
"""

import ast
import json
import sys


def symbols(source: str) -> list[str]:
    """Declarations in one module, in the extractor's vocabulary."""
    tree = ast.parse(source)
    names: list[str] = []

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            names.append(node.name)
            # Only methods directly on the class. The extractor anchors on one
            # level of indentation, so anything nested deeper is out of scope
            # for both sides.
            for member in node.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    names.append(f"{node.name}.{member.name}")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.append(node.name)

    return names


def main() -> None:
    out: dict[str, list[str]] = {}

    for path in (line.strip() for line in sys.stdin):
        if not path:
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                out[path] = symbols(handle.read())
        except (SyntaxError, UnicodeDecodeError, OSError) as err:
            # A file the interpreter cannot parse is not a fair thing to grade
            # against. Say so on stderr and leave it out of the comparison.
            print(f"oracle: skipping {path}: {err}", file=sys.stderr)

    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
