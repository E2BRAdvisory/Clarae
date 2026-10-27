//go:build production

package app

import (
	"strings"
	"testing"
)

// The release policy (built with -tags production): no remote origin anywhere, no
// script eval, no inline script. Style 'unsafe-inline' is the documented exception
// (CodeMirror/KaTeX computed styles, ADR-0005); network access is only 'self'.
func TestProductionPolicyIsStrict(t *testing.T) {
	p := cspDirectives(ContentSecurityPolicy)
	if got := strings.Join(p["script-src"], " "); got != "'self' 'wasm-unsafe-eval'" {
		t.Errorf("script-src = %q", got)
	}
	if got := strings.Join(p["connect-src"], " "); got != "'self'" {
		t.Errorf("connect-src = %q: the frontend must reach the network only through the Go bindings", got)
	}
	if got := strings.Join(p["form-action"], " "); got != "'none'" {
		t.Errorf("form-action = %q", got)
	}
	for dir, srcs := range p {
		for _, s := range srcs {
			if strings.Contains(s, "://") || strings.Contains(s, "localhost") {
				t.Errorf("%s names an origin: %q", dir, s)
			}
			if s == "'unsafe-eval'" || (s == "'unsafe-inline'" && dir != "style-src") {
				t.Errorf("%s allows %s", dir, s)
			}
		}
	}
}
