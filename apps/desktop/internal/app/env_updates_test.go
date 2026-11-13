//go:build !js

package app

import (
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"clarae/shared/envcompat"
)

// The switch that turns the updates off is an enterprise setting (managed images, offline sites): an
// installation that has it under the name of 1.x keeps it after the update, and so does one that has it
// under the new name.
func TestUpdatesOffSwitchIsHonouredUnderBothNames(t *testing.T) {
	for _, tc := range []struct {
		name         string
		current, old string
		disabled     bool
	}{
		{"new name", "off", "", true},
		{"old name", "", "off", true},
		{"the new name wins", "on", "off", false},
		{"neither", "", "", false},
		{"another value", "", "yes", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			warnedEnv.Delete("UPDATES")
			t.Setenv(envcompat.Prefix+"UPDATES", tc.current)
			t.Setenv(envcompat.LegacyPrefix+"UPDATES", tc.old)
			a := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "1.0.0"})
			svc, err := a.updaterService()
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Contains(svc.Status().Disabled, "administrator")
			if got != tc.disabled {
				t.Fatalf("disabled by the administrator = %v, want %v (status: %q)", got, tc.disabled, svc.Status().Disabled)
			}
		})
	}
}
