package app

import (
	"strings"
	"testing"
)

func cspDirectives(v string) map[string][]string {
	out := map[string][]string{}
	for _, d := range strings.Split(v, ";") {
		if f := strings.Fields(d); len(f) > 0 {
			out[f[0]] = f[1:]
		}
	}
	return out
}

// Invariants that hold for the development and the production policy alike.
func TestContentSecurityPolicyInvariants(t *testing.T) {
	p := cspDirectives(ContentSecurityPolicy)
	for dir, want := range map[string]string{
		"default-src": "'self'",
		"object-src":  "'none'",
		"frame-src":   "'none'",
		"base-uri":    "'none'",
	} {
		if got := strings.Join(p[dir], " "); got != want {
			t.Errorf("%s = %q, want %q", dir, got, want)
		}
	}
	for dir, srcs := range p {
		for _, s := range srcs {
			if s == "*" || strings.HasPrefix(s, "https:") && !strings.Contains(s, "//") {
				t.Errorf("%s allows the wildcard source %q", dir, s)
			}
		}
	}
	if !strings.Contains(strings.Join(p["script-src"], " "), "'self'") {
		t.Errorf("script-src must allow self: %v", p["script-src"])
	}
}
