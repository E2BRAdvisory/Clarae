package syncproto_test

import (
	"bufio"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"clarae/shared/apiclient"
)

// TestCodesMatchOpenAPI keeps the application error codes of codes.go equal to
// the ErrorCode enum of api/openapi.yaml, in both directions, and checks that
// the generated client accepts every one of them.
func TestCodesMatchOpenAPI(t *testing.T) {
	spec := specErrorCodes(t, filepath.Join("..", "..", "..", "api", "openapi.yaml"))
	consts := declaredCodes(t, "codes.go")
	slices.Sort(spec)
	slices.Sort(consts)
	if !slices.Equal(spec, consts) {
		t.Fatalf("ErrorCode enum of api/openapi.yaml and syncproto constants differ:\nopenapi:   %v\nsyncproto: %v", spec, consts)
	}
	for _, c := range consts {
		if !apiclient.ErrorCode(c).Valid() {
			t.Errorf("generated apiclient.ErrorCode does not know %s: run `task gen-openapi`", c)
		}
	}
}

// specErrorCodes reads the enum of components.schemas.ErrorCode. The spec is
// plain block YAML, so a line scan is enough and keeps this module free of a
// YAML dependency.
func specErrorCodes(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var codes []string
	state := 0 // 0 looking for the schema, 1 inside it, 2 inside its enum
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		switch state {
		case 0:
			if line == "    ErrorCode:" {
				state = 1
			}
		case 1:
			if trimmed == "enum:" {
				state = 2
			} else if indent(line) <= 4 && trimmed != "" {
				t.Fatal("ErrorCode schema has no enum")
			}
		case 2:
			if v, ok := strings.CutPrefix(trimmed, "- "); ok {
				codes = append(codes, strings.Trim(v, `'"`))
				continue
			}
			if trimmed != "" {
				return codes
			}
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if len(codes) == 0 {
		t.Fatal("ErrorCode enum not found in the spec")
	}
	return codes
}

func indent(s string) int { return len(s) - len(strings.TrimLeft(s, " ")) }

// declaredCodes lists the values of the constants of type Code in file.
func declaredCodes(t *testing.T, file string) []string {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var codes []string
	for _, d := range f.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok || g.Tok != token.CONST {
			continue
		}
		for _, s := range g.Specs {
			vs := s.(*ast.ValueSpec)
			if id, ok := vs.Type.(*ast.Ident); !ok || id.Name != "Code" {
				continue
			}
			for _, v := range vs.Values {
				lit, ok := v.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					t.Fatalf("Code constant with a non-literal value: %v", v)
				}
				s, err := strconv.Unquote(lit.Value)
				if err != nil {
					t.Fatal(err)
				}
				codes = append(codes, s)
			}
		}
	}
	return codes
}
