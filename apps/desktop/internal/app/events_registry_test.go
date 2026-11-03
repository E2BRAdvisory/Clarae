//go:build !js

package app

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"memobrain/apps/desktop/internal/events"
)

// moduleRoot is apps/desktop, seen from this package's directory.
const moduleRoot = "../.."

// rawEmitAllowed are the functions that may call an emitter by name: the emitter itself and the
// hosts that deliver what it gets (file relative to apps/desktop, then the enclosing function).
var rawEmitAllowed = map[string][]string{
	"internal/app/events.go":     {"emit"},
	"internal/app/host_wails.go": {"Emit"},
	"internal/app/host_web.go":   {"Emit"},
	"internal/events/events.go":  {"Send"},
	"main.go":                    {"emitTo"},
}

var wireNameRE = regexp.MustCompile(`^[a-z]+(-[a-z]+)*:[a-z]+(-[a-z]+)*$`)

type goFile struct {
	rel  string
	file *ast.File
}

// sourceFiles parses every non-test Go file of apps/desktop, whatever its build tags.
func sourceFiles(t *testing.T) []goFile {
	t.Helper()
	var out []goFile
	fset := token.NewFileSet()
	err := filepath.WalkDir(moduleRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "frontend", "node_modules", "build", "testdata":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(moduleRoot, path)
		out = append(out, goFile{rel: filepath.ToSlash(rel), file: f})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 50 {
		t.Fatalf("only %d Go files found under %s: wrong directory?", len(out), moduleRoot)
	}
	return out
}

func calleeName(fun ast.Expr) string {
	switch f := fun.(type) {
	case *ast.Ident:
		return f.Name
	case *ast.SelectorExpr:
		return f.Sel.Name
	case *ast.IndexExpr: // events.New[P]
		return calleeName(f.X)
	case *ast.IndexListExpr:
		return calleeName(f.X)
	}
	return ""
}

func isEventsPkg(fun ast.Expr) bool {
	switch f := fun.(type) {
	case *ast.IndexExpr:
		return isEventsPkg(f.X)
	case *ast.SelectorExpr:
		id, ok := f.X.(*ast.Ident)
		return ok && id.Name == "events"
	}
	return false
}

// TestEventRegistry keeps the registry, the declarations and the call sites in step (ADR-0045 §5):
// every event declared with events.New/NewSignal is listed in Events (and only those), and nothing
// sends an event by name around its declaration. The generated TypeScript then cannot miss one.
func TestEventRegistry(t *testing.T) {
	declared := map[string]string{} // wire name → where
	declLits := map[*ast.BasicLit]bool{}
	files := sourceFiles(t)
	for _, gf := range files {
		for _, decl := range gf.file.Decls {
			fn, _ := decl.(*ast.FuncDecl)
			ast.Inspect(decl, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				name := calleeName(call.Fun)
				// Declarations.
				if (name == "New" || name == "NewSignal") && isEventsPkg(call.Fun) {
					if len(call.Args) == 0 {
						t.Errorf("%s: events.%s without a name", gf.rel, name)
						return true
					}
					lit, ok := call.Args[0].(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING {
						t.Errorf("%s: events.%s must be given its name as a string literal", gf.rel, name)
						return true
					}
					wire, _ := strconv.Unquote(lit.Value)
					if prev, dup := declared[wire]; dup {
						t.Errorf("event %q declared twice (%s, %s)", wire, prev, gf.rel)
					}
					declared[wire] = gf.rel
					declLits[lit] = true
					return true
				}
				// Any other call given an event-shaped name and a payload (`f("area:what", p)`, whatever f is
				// called) sends an unregistered event by name.
				for i, a := range call.Args {
					lit, ok := a.(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING || i >= 2 || i+1 >= len(call.Args) {
						continue
					}
					if s, _ := strconv.Unquote(lit.Value); wireNameRE.MatchString(s) {
						t.Errorf("%s: %s(%q, …) looks like an event sent by name; declare it with events.New", gf.rel, name, s)
					}
				}
				// Sending by name: emit(name, payload), host.Emit(ctx, name, payload), runtime.EventsEmit(ctx, name, …).
				if len(call.Args) >= 2 && (name == "emit" || name == "Emit" || name == "EventsEmit" || name == "emitter") {
					enclosing := ""
					if fn != nil {
						enclosing = fn.Name.Name
					}
					if !slices.Contains(rawEmitAllowed[gf.rel], enclosing) {
						t.Errorf("%s (%s): %s(…) sends an event by name; declare it with events.New and use its Send",
							gf.rel, enclosing, name)
					}
				}
				return true
			})
		}
	}

	// An event name written anywhere else (a constant, an argument) is a send in disguise.
	for _, gf := range files {
		ast.Inspect(gf.file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING || declLits[lit] {
				return true
			}
			if s, _ := strconv.Unquote(lit.Value); wireNameRE.MatchString(s) {
				if _, known := declared[s]; known {
					t.Errorf("%s: the event name %q is written by hand; use its declaration", gf.rel, s)
				}
			}
			return true
		})
	}

	listed := map[string]bool{}
	for _, s := range Events {
		if listed[s.Name] {
			t.Errorf("event %q listed twice in Events", s.Name)
		}
		listed[s.Name] = true
		if _, ok := declared[s.Name]; !ok {
			t.Errorf("event %q is in Events but not declared with events.New/NewSignal", s.Name)
		}
	}
	for wire, where := range declared {
		if !listed[wire] {
			t.Errorf("event %q (%s) is not listed in Events (events_registry.go)", wire, where)
		}
	}
}

// TestEventEnumsComplete checks every enum of the registry against the constants of its type, so a
// new phase or reason reaches the TypeScript union.
func TestEventEnumsComplete(t *testing.T) {
	for _, e := range EventEnums {
		dir := packageDir(t, e.Type.PkgPath())
		want := constantsOf(t, dir, e.Type.Name())
		got := slices.Clone(e.Values)
		sort.Strings(got)
		if !slices.Equal(got, want) {
			t.Errorf("enum %s lists %v, its constants are %v", e.Type, got, want)
		}
	}
}

func packageDir(t *testing.T, pkg string) string {
	t.Helper()
	switch {
	case strings.HasPrefix(pkg, "memobrain/apps/desktop/"):
		return filepath.Join(moduleRoot, strings.TrimPrefix(pkg, "memobrain/apps/desktop/"))
	case strings.HasPrefix(pkg, "memobrain/shared/"):
		return filepath.Join(moduleRoot, "../../shared/go", strings.TrimPrefix(pkg, "memobrain/shared/"))
	}
	t.Fatalf("no directory known for package %s", pkg)
	return ""
}

// constantsOf returns the values of the string constants of type name declared in dir, sorted.
func constantsOf(t *testing.T, dir, name string) []string {
	t.Helper()
	fset := token.NewFileSet()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, en := range entries {
		if !strings.HasSuffix(en.Name(), ".go") || strings.HasSuffix(en.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, en.Name()), nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range f.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, sp := range gd.Specs {
				vs := sp.(*ast.ValueSpec)
				id, ok := vs.Type.(*ast.Ident)
				if !ok || id.Name != name {
					continue
				}
				for _, v := range vs.Values {
					lit, ok := v.(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING {
						t.Errorf("%s: a constant of %s is not a string literal", dir, name)
						continue
					}
					s, _ := strconv.Unquote(lit.Value)
					out = append(out, s)
				}
			}
		}
	}
	sort.Strings(out)
	if len(out) == 0 {
		t.Errorf("no constant of type %s in %s", name, dir)
	}
	return out
}

// TestEventsGenUpToDate fails when packages/workbench/src/app/events.gen.ts does not match the
// registry (run `task gen`).
func TestEventsGenUpToDate(t *testing.T) {
	want, err := events.TypeScript(Events, EventEnums)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(moduleRoot, "../../packages/workbench/src/app/events.gen.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("packages/workbench/src/app/events.gen.ts is out of date: run `task gen`")
	}
}
