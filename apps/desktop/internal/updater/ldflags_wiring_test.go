//go:build !js

package updater

import (
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

// TestLdflagsReachThePackage runs TestLdflagsProbe the way the release build
// does, with made-up values, so that renaming the module, the package or one of
// the three variables without the probe following fails in `task ci` and not
// only when a release is built.
func TestLdflagsReachThePackage(t *testing.T) {
	if testing.Short() {
		t.Skip("compiles the package again")
	}
	pkg := reflect.TypeOf(Service{}).PkgPath()
	ldflags := strings.Join([]string{
		"-X " + pkg + ".PublicKeyB64=probe-key",
		"-X " + pkg + ".DisabledByBuild=1",
		"-X " + pkg + ".ManifestBaseURL=https://probe.invalid/desktop",
	}, " ")
	run := func(env ...string) ([]byte, error) {
		cmd := exec.Command("go", "test", "-count=1", "-run", "^TestLdflagsProbe$", "-ldflags", ldflags, ".") //nolint:gosec // test harness: fixed command, flags built here
		cmd.Env = append(os.Environ(), append([]string{"UPDATER_PROBE=1"}, env...)...)
		return cmd.CombinedOutput()
	}

	out, err := run("UPDATER_EXPECT_PUBLIC_KEY=probe-key", "UPDATER_EXPECT_DISABLED=1",
		"UPDATER_EXPECT_BASE_URL=https://probe.invalid/desktop")
	if err != nil {
		t.Fatalf("the probe did not see the flags it was built with: %v\n%s", err, out)
	}
	// The probe must be able to fail: a flag that is not passed is reported.
	if out, err := run("UPDATER_EXPECT_PUBLIC_KEY=another-key", "UPDATER_EXPECT_DISABLED=1"); err == nil {
		t.Fatalf("the probe passed with a key the build did not have:\n%s", out)
	}
}
