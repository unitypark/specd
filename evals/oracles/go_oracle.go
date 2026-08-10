// Independent oracle for Go symbol extraction.
//
// Uses go/parser and go/ast — the same parser the toolchain uses — so it
// shares no assumption with the line-based extractor it grades. Reads
// newline-separated file paths on stdin, writes
// {"path": ["qualifiedName", ...]} to stdout.
//
// Stdin rather than argv because `go run x.go a.go b.go` treats every .go
// argument as another source file to compile, and because a large repository
// would otherwise overrun the argument limit.
//
// Restricted to the declaration shapes the extractor claims to find:
// top-level funcs, receiver methods as Type.Method, struct/interface type
// declarations, and top-level const/var names. Grading against everything a
// real parser can see would measure the distance between a tier and a
// compiler, which is already known and is not the question.
//
// Run standalone (`go run go_oracle.go ...`) — deliberately no go.mod, so it
// cannot drift into the CLI's module or be caught by `pnpm cli:test`.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

func main() {
	out := map[string][]string{}
	fset := token.NewFileSet()

	paths := []string{}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			paths = append(paths, line)
		}
	}

	for _, path := range paths {
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			// A file the toolchain cannot parse is not a fair thing to grade
			// against. Say so on stderr and leave it out of the comparison.
			fmt.Fprintf(os.Stderr, "oracle: skipping %s: %v\n", path, err)
			continue
		}

		names := []string{}
		for _, decl := range file.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if d.Recv != nil && len(d.Recv.List) > 0 {
					if recv := receiverType(d.Recv.List[0].Type); recv != "" {
						names = append(names, recv+"."+d.Name.Name)
					}
					continue
				}
				names = append(names, d.Name.Name)

			case *ast.GenDecl:
				for _, spec := range d.Specs {
					switch s := spec.(type) {
					case *ast.TypeSpec:
						// Only struct and interface: the extractor's rule is
						// `type X struct|interface`, so type aliases are out
						// of scope for both sides.
						switch s.Type.(type) {
						case *ast.StructType, *ast.InterfaceType:
							names = append(names, s.Name.Name)
						}
					case *ast.ValueSpec:
						if d.Tok == token.CONST || d.Tok == token.VAR {
							for _, n := range s.Names {
								if n.Name != "_" {
									names = append(names, n.Name)
								}
							}
						}
					}
				}
			}
		}
		out[path] = names
	}

	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "oracle:", err)
		os.Exit(1)
	}
}

// receiverType unwraps `(c *Client)` and `(c Client)` to "Client".
func receiverType(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.StarExpr:
		return receiverType(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr: // generic receiver, e.g. (s *Set[T])
		return receiverType(t.X)
	case *ast.IndexListExpr:
		return receiverType(t.X)
	}
	return ""
}
