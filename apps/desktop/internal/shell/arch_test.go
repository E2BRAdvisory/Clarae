//go:build !js

package shell

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// internal/app is the core that also runs as WebAssembly in the browser (ADR-0029, ADR-0030): it
// must not depend on the desktop toolkit, whichever version (Wails v2 today, v3 later, whose
// application package needs cgo and GTK on Linux). Everything Wails goes through internal/shell.
func TestAppDoesNotImportWails(t *testing.T) {
	for _, env := range [][]string{
		nil, // the native build
		{"GOOS=js", "GOARCH=wasm"},
	} {
		name := "native"
		if env != nil {
			name = strings.Join(env, " ")
		}
		t.Run(name, func(t *testing.T) {
			cmd := exec.Command("go", "list", "-deps", "-f", "{{.ImportPath}}", "clarae/apps/desktop/internal/app")
			cmd.Env = append(os.Environ(), env...)
			out, err := cmd.Output()
			if err != nil {
				msg := ""
				var ee *exec.ExitError
				if errors.As(err, &ee) {
					msg = string(ee.Stderr)
				}
				t.Fatalf("go list -deps (%s): %v\n%s", name, err, msg)
			}
			deps := strings.Fields(string(out))
			if len(deps) < 50 {
				t.Fatalf("only %d dependencies listed: wrong package?", len(deps))
			}
			for _, d := range deps {
				if strings.HasPrefix(d, "github.com/wailsapp/") {
					t.Errorf("internal/app depends on %s (%s): Wails belongs to internal/shell", d, name)
				}
			}
		})
	}
}
