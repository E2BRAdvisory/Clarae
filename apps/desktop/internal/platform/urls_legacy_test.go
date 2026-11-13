package platform

import (
	"errors"
	"testing"
)

// The links written in notes by 1.x (open?vault=…) and the redirect URIs registered in the realms of
// existing installations still arrive: the application registers both schemes and handles both.

func TestParseSchemeURLAcceptsTheLegacyScheme(t *testing.T) {
	u, err := ParseSchemeURL("memobrain://open?vault=Work&file=Notes%2Ftoday.md")
	if err != nil || u.Kind != URLOpen || u.Params.Get("vault") != "Work" || u.Params.Get("file") != "Notes/today.md" {
		t.Fatalf("open: %+v %v", u, err)
	}
	u, err = ParseSchemeURL("MemoBrain://auth/callback?code=abc&state=xyz")
	if err != nil || u.Kind != URLAuthCallback || u.Params.Get("code") != "abc" || u.Params.Get("state") != "xyz" {
		t.Fatalf("callback: %+v %v", u, err)
	}
	u, err = ParseSchemeURL("memobrain://auth/logout")
	if err != nil || u.Kind != URLAuthLogout {
		t.Fatalf("logout: %+v %v", u, err)
	}
	if _, err := ParseSchemeURL("memobrain://whatever"); err == nil || errors.Is(err, ErrNotSchemeURL) {
		t.Fatalf("an unknown path of a known scheme is an error of its own: %v", err)
	}
}

func TestParseSchemeURLRefusesOtherSchemes(t *testing.T) {
	for _, raw := range []string{
		"https://example.com/open?vault=x",
		"file:///etc/passwd",
		"memobrainx://open?vault=x",
		"xclarae://open?vault=x",
		"javascript:alert(1)",
		"open?vault=x",
	} {
		if _, err := ParseSchemeURL(raw); !errors.Is(err, ErrNotSchemeURL) {
			t.Errorf("ParseSchemeURL(%q) = %v, want ErrNotSchemeURL", raw, err)
		}
	}
}

func TestFindSchemeURLFindsEitherScheme(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string
		ok   bool
	}{
		{"current", []string{"/bin/clarae", "clarae://open?vault=a"}, "clarae://open?vault=a", true},
		{"legacy", []string{"/bin/clarae", "--flag", "memobrain://open?vault=b"}, "memobrain://open?vault=b", true},
		{"upper case", []string{"MEMOBRAIN://open?vault=c"}, "MEMOBRAIN://open?vault=c", true},
		{"the first one", []string{"memobrain://open?vault=1", "clarae://open?vault=2"}, "memobrain://open?vault=1", true},
		{"neither", []string{"/bin/clarae", "https://example.com", "memobrainx://open", "clarae"}, "", false},
		{"nothing", nil, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := FindSchemeURL(tc.args)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("FindSchemeURL(%q) = %q, %v; want %q, %v", tc.args, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestSchemesAreTheCurrentAndTheOldOne(t *testing.T) {
	if Scheme != "clarae" {
		t.Fatalf("Scheme = %q", Scheme)
	}
	if len(LegacySchemes) != 1 || LegacySchemes[0] != "memobrain" {
		t.Fatalf("LegacySchemes = %q", LegacySchemes)
	}
}
