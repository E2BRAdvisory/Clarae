package app

import (
	"strings"
	"testing"
)

func TestRedactURLDropsSecrets(t *testing.T) {
	raw := "clarae://auth/callback?code=SECRETCODE&state=SECRETSTATE"
	got := redactURL(raw)
	if strings.Contains(got, "SECRET") || got != "clarae://auth/callback?[redacted]" {
		t.Fatalf("redactURL = %q", got)
	}
	args := redactArgs([]string{"/Applications/Clarae", raw})
	if strings.Contains(strings.Join(args, " "), "SECRET") || strings.Contains(args[0], "Applications") {
		t.Fatalf("redactArgs = %v", args)
	}
	if redactURL("%%bad") != "[redacted]" {
		t.Fatal("unparsable input must be replaced")
	}
}
