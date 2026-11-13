package updater

import (
	"os"
	"testing"
)

// TestLdflagsProbe checks that the -X flags of a build reached this package.
// The linker ignores -X on a symbol that does not exist, so a wrong package
// path or a renamed variable would leave PublicKeyB64 empty without any error:
// a release that trusts the development update key. scripts/release/build-desktop.sh
// runs this test with the ldflags of the build and UPDATER_PROBE=1 before it
// compiles the binary; without UPDATER_PROBE it is skipped.
//
//	UPDATER_EXPECT_PUBLIC_KEY  expected PublicKeyB64 (unset: empty)
//	UPDATER_EXPECT_DISABLED    expected DisabledByBuild (unset: empty)
//	UPDATER_EXPECT_BASE_URL    expected ManifestBaseURL (unset: not checked)
func TestLdflagsProbe(t *testing.T) {
	if os.Getenv("UPDATER_PROBE") != "1" {
		t.Skip("UPDATER_PROBE is not 1: run by scripts/release/build-desktop.sh with the ldflags of the build")
	}
	if want := os.Getenv("UPDATER_EXPECT_PUBLIC_KEY"); PublicKeyB64 != want {
		t.Errorf("PublicKeyB64 = %q, the build passed %q: the -X flag did not reach this package", PublicKeyB64, want)
	}
	if want := os.Getenv("UPDATER_EXPECT_DISABLED"); DisabledByBuild != want {
		t.Errorf("DisabledByBuild = %q, the build passed %q: the -X flag did not reach this package", DisabledByBuild, want)
	}
	if want, ok := os.LookupEnv("UPDATER_EXPECT_BASE_URL"); ok && ManifestBaseURL != want {
		t.Errorf("ManifestBaseURL = %q, the build passed %q: the -X flag did not reach this package", ManifestBaseURL, want)
	}
}
