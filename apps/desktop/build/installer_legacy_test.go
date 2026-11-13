//go:build !js

package build

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The installers of 1.5 replace the application of 1.x (ADR-0052): another product name, so another
// Uninstall key, install folder, executable, shortcuts and, on Linux, package name. Nothing of the
// user's is in them (the data directory, the keychain and the web view profile are taken over by the
// application at its first start), so the old application is removed and not migrated.

func readBuildFile(t *testing.T, rel ...string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(append([]string{repoRoot(), "apps", "desktop", "build"}, rel...)...))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The key that the NSIS template of 1.x derived from CompanyName+ProductName: spelt out here, because
// if it is wrong the old application stays installed next to the new one with nothing to say so.
func TestWindowsInstallerRemovesTheInstallationOf1x(t *testing.T) {
	nsi := readBuildFile(t, "windows", "installer", "project.nsi")
	for _, want := range []string{
		`!define LEGACY_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\E2BR-Advisory SaglMemoBrain Notes"`,
		`!define LEGACY_EXECUTABLE "${LEGACY_PRODUCT}.exe"`,
		`ReadRegStr $R0 HKLM "${LEGACY_UNINST_KEY}" "DisplayIcon"`, // the folder comes from the key, as the old installer wrote it
		`${GetParent} $R0 $R1`,
		`Delete "$R1\${LEGACY_EXECUTABLE}"`,
		`Delete "$R1\uninstall.exe"`,
		`RMDir "$R1"`,
		`DeleteRegKey HKLM "${LEGACY_UNINST_KEY}"`,
		`Delete "$SMPROGRAMS\${LEGACY_PRODUCT}.lnk"`,
		`Delete "$DESKTOP\${LEGACY_PRODUCT}.lnk"`,
	} {
		if !strings.Contains(nsi, want) {
			t.Errorf("project.nsi: %q not found", want)
		}
	}

	// The key is the one the template of 1.x made: the company and the product name of 1.x joined.
	companyOf1x, productOf1x := "E2BR-Advisory Sagl", "MemoBrain Notes"
	if !strings.Contains(nsi, `\`+companyOf1x+productOf1x+`"`) {
		t.Errorf("project.nsi: the key is not %q", companyOf1x+productOf1x)
	}

	// The old uninstaller is never run: it removes the web view profile of the old application, which the new one
	// adopts. Nor is the old folder removed recursively: only what the old installer wrote.
	for _, bad := range []string{"ExecWait", "ExecShell", "Exec ", "nsExec"} {
		if strings.Contains(nsi, bad) {
			t.Errorf("project.nsi: %q: the uninstaller of 1.x must not be run", bad)
		}
	}
	macro := nsi[strings.Index(nsi, "!macro clarae.removeLegacyInstall"):strings.Index(nsi, "!macroend")]
	if strings.Contains(macro, "/r") {
		t.Errorf("the removal of 1.x must not be recursive:\n%s", macro)
	}

	// It runs in the installation section, before the files of the new version are written (the folder can be
	// the same one, the shortcuts are the new ones when the names match).
	section := nsi[strings.Index(nsi, "\nSection\n"):strings.Index(nsi, `Section "uninstall"`)]
	remove := strings.Index(section, "!insertmacro clarae.removeLegacyInstall")
	files := strings.Index(section, "!insertmacro wails.files")
	if remove < 0 || files < 0 || remove > files {
		t.Errorf("clarae.removeLegacyInstall must run before wails.files (at %d and %d):\n%s", remove, files, section)
	}

	// A running application cannot be replaced: the user is asked to close it, and a silent install stops.
	for _, want := range []string{"MB_RETRYCANCEL", "IfSilent", "SetErrorLevel 5"} {
		if !strings.Contains(macro, want) {
			t.Errorf("the removal of 1.x does not handle a running application (%q missing)", want)
		}
	}
}

func TestLinuxPackageReplacesThePackageOf1x(t *testing.T) {
	yaml := readBuildFile(t, "linux", "nfpm.yaml")
	for _, key := range []string{"replaces", "conflicts"} {
		if !regexp.MustCompile(`(?m)^` + key + `:\n  - memobrain\n`).MatchString(yaml) {
			t.Errorf("nfpm.yaml: %s: [memobrain] not found", key)
		}
	}
	if !regexp.MustCompile(`(?m)^name: clarae$`).MatchString(yaml) {
		t.Error("nfpm.yaml: the package is not called clarae")
	}
}

// TestWindowsInstallerCompiles builds the installer with makensis, staged as scripts/release/build-desktop.sh does
// (installer/, ../icon.ico, ../../bin, the template of wails_tools.nsh rendered), where makensis is installed. It is
// the only check of the NSIS syntax of project.nsi that runs outside the release.
func TestWindowsInstallerCompiles(t *testing.T) {
	makensis, err := exec.LookPath("makensis")
	if err != nil {
		t.Skip("makensis is not installed")
	}
	stage := t.TempDir()
	installer := filepath.Join(stage, "windows", "installer")
	for _, dir := range []string{filepath.Join(installer, "tmp"), filepath.Join(stage, "bin")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	nsh, err := render(t, "windows/installer/wails_tools.nsh", "-version", version)
	if err != nil {
		t.Fatal(err)
	}
	icon, err := os.ReadFile(filepath.Join(repoRoot(), "apps", "desktop", "build", "windows", "icon.ico"))
	if err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(installer, "project.nsi"):                           readBuildFile(t, "windows", "installer", "project.nsi"),
		filepath.Join(installer, "wails_tools.nsh"):                       nsh,
		filepath.Join(installer, "tmp", "MicrosoftEdgeWebview2Setup.exe"): "stub",
		filepath.Join(stage, "bin", "clarae.exe"):                         "stub",
		filepath.Join(stage, "windows", "icon.ico"):                       string(icon),
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command(makensis, "-V2", `-DARG_WAILS_AMD64_BINARY=..\..\bin\clarae.exe`, "project.nsi") //nolint:gosec // the tool found on the PATH, fixed arguments
	cmd.Dir = installer
	cmd.Env = append(os.Environ(), "CLARAE_SIGNTOOL_CMD=") // unsigned: there is nothing to sign with here
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("makensis: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(stage, "bin", "clarae-amd64-installer.exe")); err != nil {
		t.Fatalf("makensis did not produce the installer: %v", err)
	}
}
