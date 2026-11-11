//go:build !js

package ai

import (
	"errors"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

// The WebAssembly core must not contain the assistant (ADR-0050): the Content-Security-Policy of the
// page allows no third party, the core has a size budget (ADR-0030), and a key kept by code in the
// page would be in the page. internal/app reaches this package only through bindings_ai.go, which has
// the `!js` tag; the browser gets bindings_ai_js.go, whose AIAPI refuses every call.
func TestWebAssemblyCoreDoesNotLinkTheAssistant(t *testing.T) {
	deps := func(env ...string) []string {
		t.Helper()
		cmd := exec.Command("go", "list", "-deps", "-f", "{{.ImportPath}}", "memobrain/apps/desktop/internal/app")
		cmd.Env = append(os.Environ(), env...)
		out, err := cmd.Output()
		if err != nil {
			msg := ""
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				msg = string(ee.Stderr)
			}
			t.Fatalf("go list -deps %v: %v\n%s", env, err, msg)
		}
		return strings.Fields(string(out))
	}
	const pkg = "memobrain/apps/desktop/internal/ai"
	if !slices.Contains(deps(), pkg) {
		t.Fatalf("the desktop core does not link %s: the check below proves nothing", pkg)
	}
	web := deps("GOOS=js", "GOARCH=wasm")
	if len(web) < 50 {
		t.Fatalf("only %d dependencies listed: wrong package?", len(web))
	}
	for _, d := range web {
		if d == pkg || strings.HasPrefix(d, pkg+"/") {
			t.Errorf("the WebAssembly core links %s", d)
		}
	}
}
