//go:build !js

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/app"
	"memobrain/apps/desktop/internal/app/gen/bindings/fixture"
)

// goldenModule is the module path as the golden holds it (testdata/regen-golden.sh), in the form a generic type
// argument is written in: the name of such a type carries the import path of its package, which changes with
// `task rename-module`. It is not spelled as a path on purpose: rename-module rewrites paths, not this.
const goldenModule = "memobrain_apps_desktop"

// fixtureSuffix is the import path of the fixture package inside the module.
const fixtureSuffix = "/internal/app/gen/bindings/fixture"

// modulePath is the module this test is built from, taken from the import path of the fixture package.
func modulePath(t *testing.T) string {
	t.Helper()
	pkg := reflect.TypeOf(fixture.Link{}).PkgPath()
	module, ok := strings.CutSuffix(pkg, fixtureSuffix)
	if !ok || module == "" {
		t.Fatalf("cannot derive the module path from %q", pkg)
	}
	return module
}

// sanitized is the module path as a generic type argument is written in the bindings.
func sanitized(module string) string {
	return jsVariableUnsafeChars.ReplaceAllLiteralString(module, "_")
}

// The generator writes, for the fixture package, exactly what `wails generate module` (Wails v2.17.1) wrote:
// the golden is that CLI's output (testdata/regen-golden.sh), not the generator's own. The module path is the
// only thing that may differ: it is brought to goldenModule before the comparison.
func TestGeneratorMatchesWailsV2(t *testing.T) {
	files, err := Generate(fixture.Services())
	if err != nil {
		t.Fatal(err)
	}
	if module := sanitized(modulePath(t)); module != goldenModule {
		from, to := []byte(module), []byte(goldenModule)
		for name, data := range files {
			files[name] = bytes.ReplaceAll(data, from, to)
		}
	}
	golden := map[string][]byte{}
	root := filepath.Join("testdata", "golden")
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		golden[strings.TrimSuffix(filepath.ToSlash(rel), ".golden")] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(golden) == 0 {
		t.Fatal("testdata/golden is empty")
	}
	for name, want := range golden {
		got, ok := files[name]
		if !ok {
			t.Errorf("%s: Wails writes it, the generator does not", name)
		} else if !bytes.Equal(got, want) {
			t.Errorf("%s differs from what Wails v2 writes\n--- generator\n%s\n--- wails\n%s", name, got, want)
		}
	}
	for name := range files {
		if _, ok := golden[name]; !ok {
			t.Errorf("%s: the generator writes it, Wails does not", name)
		}
	}
}

// The map iterations of the reflection must not leak into the output.
func TestGenerateIsDeterministic(t *testing.T) {
	first, err := Generate(newServices())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		again, err := Generate(newServices())
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(first, again) {
			t.Fatalf("run %d wrote a different tree", i+2)
		}
	}
}

func newServices() []any {
	return app.New(app.Options{Logger: zerolog.Nop(), Version: "test"}).Services()
}

// The tree of the application: a pair of files per service, one function per exported method, and the
// classes every service refers to.
func TestGenerateCoversEveryService(t *testing.T) {
	services := newServices()
	files, err := Generate(services)
	if err != nil {
		t.Fatal(err)
	}
	fn := regexp.MustCompile(`(?m)^export function (\w+)\(`)
	for _, s := range services {
		typ := reflect.TypeOf(s)
		name := typ.Elem().Name()
		js, dts := files["go/app/"+name+".js"], files["go/app/"+name+".d.ts"]
		if js == nil || dts == nil {
			t.Fatalf("%s: no bindings written", name)
		}
		var want []string
		for i := 0; i < typ.NumMethod(); i++ {
			want = append(want, typ.Method(i).Name)
		}
		for kind, data := range map[string][]byte{"js": js, "d.ts": dts} {
			var got []string
			for _, m := range fn.FindAllSubmatch(data, -1) {
				got = append(got, string(m[1]))
			}
			if !sort.StringsAreSorted(got) || !reflect.DeepEqual(got, want) {
				t.Errorf("%s.%s declares %v, want the methods of the service %v", name, kind, got, want)
			}
		}
	}
	models := string(files["go/models.ts"])
	for _, ns := range []string{"app", "cloudapi", "sync"} {
		if !strings.Contains(models, "export namespace "+ns+" {") {
			t.Errorf("models.ts has no namespace %q", ns)
		}
	}
	// Every namespace a binding imports is declared in models.ts.
	imp := regexp.MustCompile(`(?m)^import \{(\w+)\} from '../models';`)
	for name, data := range files {
		if !strings.HasSuffix(name, ".d.ts") || !strings.HasPrefix(name, "go/") {
			continue
		}
		for _, m := range imp.FindAllSubmatch(data, -1) {
			if ns := string(m[1]); ns != "time" && !strings.Contains(models, "export namespace "+ns+" {") {
				t.Errorf("%s imports %q, which models.ts does not declare", name, ns)
			}
		}
	}
	for _, name := range []string{"runtime/runtime.js", "runtime/runtime.d.ts", "runtime/package.json"} {
		if len(files[name]) == 0 {
			t.Errorf("%s is missing", name)
		}
	}
}

type notAService struct{}

func TestGenerateRejectsWhatIsNotAPointerToAStruct(t *testing.T) {
	for _, s := range []any{notAService{}, func() {}, "service", nil} {
		if _, err := Generate([]any{s}); err == nil {
			t.Errorf("%T was accepted", s)
		}
	}
}

// write brings go/ and runtime/ to the generated files and leaves anything else of wailsjs alone.
func TestWriteSyncsTheOwnedTrees(t *testing.T) {
	dir := t.TempDir()
	put := func(name, content string) {
		t.Helper()
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put("go/app/Gone.js", "stale")
	put("go/gone/Old.d.ts", "stale")
	put("README", "not ours")
	put("go/app/Keep.js", "old")

	files := map[string][]byte{"go/app/Keep.js": []byte("new"), "go/app/New.js": []byte("n"), "runtime/runtime.js": []byte("r")}
	stale, err := diff(dir, files)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"go/app/Gone.js", "go/app/Keep.js", "go/app/New.js", "go/gone/Old.d.ts", "runtime/runtime.js"}; !reflect.DeepEqual(stale, want) {
		t.Fatalf("diff = %v, want %v", stale, want)
	}
	wrote, err := write(dir, files)
	if err != nil || wrote != 3 {
		t.Fatalf("write = %d, %v; want 3 files", wrote, err)
	}
	if stale, err := diff(dir, files); err != nil || len(stale) != 0 {
		t.Fatalf("after write: diff = %v, %v", stale, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "go", "gone")); !os.IsNotExist(err) {
		t.Errorf("the directory of a dropped service stays: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "README")); err != nil || string(data) != "not ours" {
		t.Errorf("a file outside go/ and runtime/ was touched: %q, %v", data, err)
	}
	if wrote, err := write(dir, files); err != nil || wrote != 0 {
		t.Errorf("a second write wrote %d files, %v", wrote, err)
	}
}
