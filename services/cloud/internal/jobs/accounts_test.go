package jobs

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/keycloak"
)

type fakeDisabler struct {
	err      error
	disabled []string
}

func (f *fakeDisabler) SetEnabled(_ context.Context, sub string, enabled bool) error {
	if f.err != nil {
		return f.err
	}
	if !enabled {
		f.disabled = append(f.disabled, sub)
	}
	return nil
}

// The purge disables the Keycloak account once more and reports the outcome
// for the audit entry; when it cannot, it warns the operator.
func TestDisableIdentityOutcomes(t *testing.T) {
	for name, c := range map[string]struct {
		kc      IdentityDisabler
		subject string
		want    string
		warns   bool
	}{
		"disabled":             {kc: &fakeDisabler{}, subject: "kc-1", want: identityDisabled},
		"gone in keycloak":     {kc: &fakeDisabler{err: keycloak.ErrNotFound}, subject: "kc-1", want: identityNotFound},
		"no admin api":         {kc: keycloak.Disabled{}, subject: "kc-1", want: identityNotConfigured, warns: true},
		"no client wired":      {kc: nil, subject: "kc-1", want: identityNotConfigured, warns: true},
		"keycloak failing":     {kc: &fakeDisabler{err: errors.New("503")}, subject: "kc-1", want: identityFailed, warns: true},
		"subject already gone": {kc: &fakeDisabler{}, subject: "", want: identityNotFound},
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			r := (&Runner{log: zerolog.New(&buf)}).WithIdentityProvider(c.kc)
			if got := r.disableIdentity(context.Background(), uuid.New(), c.subject); got != c.want {
				t.Fatalf("outcome %q, want %q", got, c.want)
			}
			if warned := strings.Contains(buf.String(), `"level":"warn"`); warned != c.warns {
				t.Fatalf("warned=%v, want %v: %s", warned, c.warns, buf.String())
			}
			if f, ok := c.kc.(*fakeDisabler); ok && c.want == identityDisabled && (len(f.disabled) != 1 || f.disabled[0] != c.subject) {
				t.Fatalf("disabled %v", f.disabled)
			}
		})
	}
}
