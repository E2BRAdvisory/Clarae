package platform

import (
	"errors"
	"testing"
)

func TestParseSchemeURL(t *testing.T) {
	u, err := ParseSchemeURL("nodus://open?vault=Work&file=Notes%2Ftoday.md")
	if err != nil || u.Kind != URLOpen || u.Params.Get("vault") != "Work" || u.Params.Get("file") != "Notes/today.md" {
		t.Fatalf("open: %+v %v", u, err)
	}
	u, err = ParseSchemeURL("NODUS://auth/callback?code=abc&state=xyz")
	if err != nil || u.Kind != URLAuthCallback || u.Params.Get("code") != "abc" {
		t.Fatalf("callback: %+v %v", u, err)
	}
	if _, err := ParseSchemeURL("https://example.com"); !errors.Is(err, ErrNotSchemeURL) {
		t.Fatalf("expected ErrNotSchemeURL, got %v", err)
	}
	if _, err := ParseSchemeURL("nodus://whatever"); err == nil {
		t.Fatal("unknown path must fail")
	}
	if got, ok := FindSchemeURL([]string{"nodus", "--flag", "nodus://open?vault=x"}); !ok || got != "nodus://open?vault=x" {
		t.Fatalf("FindSchemeURL: %q %v", got, ok)
	}
}

func TestInstanceID(t *testing.T) {
	a, b := InstanceID("/tmp/a"), InstanceID("/tmp/b")
	if a == b || a != InstanceID("/tmp/a/") {
		t.Fatalf("instance ids: %s %s", a, b)
	}
}
