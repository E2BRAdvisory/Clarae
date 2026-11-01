package users

import (
	"testing"
	"time"
)

// The stored role stands against tokens issued up to the change (iat has a
// one-second precision, so the second of the change counts as before), and a
// later token mirrors the realm role again (ADR-0041).
func TestEffectiveRole(t *testing.T) {
	changed := time.Date(2026, 11, 1, 12, 0, 0, 500_000_000, time.UTC)
	for name, c := range map[string]struct {
		changedAt *time.Time
		issued    time.Time
		want      string
	}{
		"never changed: the token decides":     {nil, changed.Add(-time.Hour), "admin"},
		"token older than the demotion":        {&changed, changed.Add(-time.Minute), "user"},
		"token of the same second (truncated)": {&changed, changed.Truncate(time.Second), "user"},
		"token issued after the change":        {&changed, changed.Add(time.Second).Truncate(time.Second), "admin"},
		"token without iat":                    {&changed, time.Time{}, "user"},
	} {
		if got := EffectiveRole("user", c.changedAt, "admin", c.issued); got != c.want {
			t.Errorf("%s: got %s, want %s", name, got, c.want)
		}
	}
}

func TestLikeEscape(t *testing.T) {
	if got := likeEscape(`a%b_c\d`); got != `a\%b\_c\\d` {
		t.Fatalf("got %q", got)
	}
}
