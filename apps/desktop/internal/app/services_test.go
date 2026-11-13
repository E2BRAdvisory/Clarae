package app

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"clarae/apps/desktop/internal/rpc"
)

func newDispatcher(t *testing.T, a *App) *rpc.Dispatcher {
	t.Helper()
	d := rpc.New()
	for _, s := range a.Services() {
		if err := d.Register(s); err != nil {
			t.Fatalf("the dispatcher cannot expose %T: %v", s, err)
		}
	}
	return d
}

// Every API struct Wails binds must be callable through the dispatcher the browser build uses.
func TestDispatcherExposesEveryService(t *testing.T) {
	a, _, _ := newTestApp(t)
	got := newDispatcher(t, a).Methods()
	for _, s := range a.Services() {
		typ := reflect.TypeOf(s)
		var want []string
		for i := 0; i < typ.NumMethod(); i++ {
			want = append(want, typ.Method(i).Name)
		}
		sort.Strings(want)
		if name := typ.Elem().Name(); !reflect.DeepEqual(got[name], want) {
			t.Errorf("%s: dispatcher exposes %v, want %v", name, got[name], want)
		}
	}
	if len(got) != len(a.Services()) {
		t.Errorf("dispatcher has %d services, want %d", len(got), len(a.Services()))
	}
}

// The TypeScript bindings (packages/workbench/wailsjs, generated from App.Services() by `task gen-wails`,
// i.e. internal/app/gen/bindings) are what the UI calls: each function they declare must exist in the
// dispatcher, and the dispatcher must not offer methods the UI cannot call. Skipped when the bindings
// have not been generated, unless CLARAE_REQUIRE_BINDINGS is set (`task ci` sets it).
func TestDispatcherMatchesTheGeneratedBindings(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "packages", "workbench", "wailsjs", "go", "app")
	files, _ := filepath.Glob(filepath.Join(dir, "*.d.ts"))
	if len(files) == 0 {
		if os.Getenv("CLARAE_REQUIRE_BINDINGS") != "" {
			t.Fatal("packages/workbench/wailsjs is not generated (task wailsjs)")
		}
		t.Skip("packages/workbench/wailsjs is not generated (task wailsjs)")
	}
	a, _, _ := newTestApp(t)
	exposed := newDispatcher(t, a).Methods()
	fn := regexp.MustCompile(`(?m)^export function (\w+)\(`)
	declared := map[string][]string{}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		service := strings.TrimSuffix(filepath.Base(f), ".d.ts")
		for _, m := range fn.FindAllSubmatch(data, -1) {
			declared[service] = append(declared[service], string(m[1]))
		}
		sort.Strings(declared[service])
	}
	if !reflect.DeepEqual(declared, exposed) {
		for service, want := range declared {
			if !reflect.DeepEqual(exposed[service], want) {
				t.Errorf("%s: bindings declare %v, dispatcher exposes %v", service, want, exposed[service])
			}
		}
		for service := range exposed {
			if _, ok := declared[service]; !ok {
				t.Errorf("%s: exposed by the dispatcher but missing from the generated bindings (run task gen-wails)", service)
			}
		}
	}
}

// A call through the dispatcher behaves like the binding itself: JSON in, JSON out, errors as messages.
func TestDispatcherCallsRealBindings(t *testing.T) {
	a, _, _ := newTestApp(t)
	d := newDispatcher(t, a)

	info, err := d.Call("SettingsAPI", "Info", "[]")
	if err != nil || !strings.Contains(info, `"platform"`) {
		t.Fatalf("SettingsAPI.Info = %s, %v", info, err)
	}

	dir := t.TempDir()
	opened, err := d.Call("VaultAPI", "OpenVault", `["`+filepath.ToSlash(dir)+`"]`)
	if err != nil {
		t.Fatalf("OpenVault: %v", err)
	}
	id := regexp.MustCompile(`"id":"([^"]+)"`).FindStringSubmatch(opened)
	if id == nil {
		t.Fatalf("OpenVault returned %s", opened)
	}
	if _, err := d.Call("VaultAPI", "WriteNote", `["`+id[1]+`","Hello.md","# Hi\n",""]`); err != nil {
		t.Fatalf("WriteNote: %v", err)
	}
	note, err := d.Call("VaultAPI", "ReadNote", `["`+id[1]+`","Hello.md"]`)
	if err != nil || !strings.Contains(note, `# Hi`) {
		t.Fatalf("ReadNote = %s, %v", note, err)
	}
	if _, err := d.Call("VaultAPI", "ReadNote", `["`+id[1]+`","missing.md"]`); err == nil || !strings.Contains(strings.ToLower(err.Error()), "no such file") {
		t.Fatalf("a missing note must reject with the binding's error message, got %v", err)
	}
}
