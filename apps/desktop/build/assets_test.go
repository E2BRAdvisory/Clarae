//go:build !js

// Package build holds the checks of the release assets in this directory: the templates the release scripts
// render with scripts/release/render-assets.go (macOS Info.plist, Windows info.json, manifest and NSIS tools) must
// come out without a placeholder left, and with the identifiers the installed 1.x apps and the updater rely on
// (ADR-0023, ADR-0031, ADR-0051 B-D10). The package has no code: it exists to be tested.
package build

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

const version = "1.3.4"

var (
	buildOnce sync.Once
	toolDir   string
	toolPath  string
	toolErr   error
)

// TestMain removes the compiled tool after the run.
func TestMain(m *testing.M) {
	code := m.Run()
	if toolDir != "" {
		_ = os.RemoveAll(toolDir)
	}
	os.Exit(code)
}

// renderTool compiles scripts/release/render-assets.go once for the whole test run.
func renderTool(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "render-assets")
		if err != nil {
			toolErr = err
			return
		}
		toolDir = dir
		toolPath = filepath.Join(dir, "render-assets")
		src := filepath.Join(repoRoot(), "scripts", "release", "render-assets.go")
		cmd := exec.Command("go", "build", "-o", toolPath, src) //nolint:gosec // fixed arguments, a file of this repository
		cmd.Env = append(os.Environ(), "GOWORK=off")
		if out, err := cmd.CombinedOutput(); err != nil {
			toolErr = &buildError{err: err, out: string(out)}
		}
	})
	if toolErr != nil {
		t.Fatalf("building render-assets: %v", toolErr)
	}
	return toolPath
}

type buildError struct {
	err error
	out string
}

func (e *buildError) Error() string { return e.err.Error() + "\n" + e.out }

func repoRoot() string {
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		panic(err)
	}
	return root
}

func projectJSON() string {
	return filepath.Join(repoRoot(), "apps", "desktop", "build", "project.json")
}

// render runs render-assets on a template of apps/desktop/build.
func render(t *testing.T, template string, extra ...string) (string, error) {
	t.Helper()
	out := filepath.Join(t.TempDir(), "out")
	args := append([]string{"-project", projectJSON()}, extra...)
	args = append(args, "-out", out, filepath.Join(repoRoot(), "apps", "desktop", "build", filepath.FromSlash(template)))
	cmd := exec.Command(renderTool(t), args...) //nolint:gosec // the tool built above
	if combined, err := cmd.CombinedOutput(); err != nil {
		return string(combined), err
	}
	raw, err := os.ReadFile(out)
	return string(raw), err
}

func TestTemplatesRenderWithoutPlaceholders(t *testing.T) {
	for _, tpl := range []string{
		"darwin/Info.plist",
		"darwin/Info.dev.plist",
		"windows/info.json",
		"windows/wails.exe.manifest",
		"windows/installer/wails_tools.nsh",
	} {
		t.Run(tpl, func(t *testing.T) {
			got, err := render(t, tpl, "-version", version)
			if err != nil {
				t.Fatalf("render %s: %v\n%s", tpl, err, got)
			}
			for _, bad := range []string{"{{", "}}", "<no value>"} {
				if strings.Contains(got, bad) {
					t.Errorf("%s: %q left in the rendered output", tpl, bad)
				}
			}
			if !strings.Contains(got, version) {
				t.Errorf("%s: version %s not stamped", tpl, version)
			}
		})
	}
}

// TestRenderedIdentifiers pins what installed apps, the registry and the updater depend on: changing one of these
// would turn an update into a second installation.
func TestRenderedIdentifiers(t *testing.T) {
	plist, err := render(t, "darwin/Info.plist", "-version", version)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`<key>CFBundleIdentifier</key>\s*<string>dev\.clarae\.desktop</string>`,
		`<key>CFBundleExecutable</key>\s*<string>clarae</string>`,
		`<key>CFBundleName</key>\s*<string>Clarae notanda</string>`,
		`<key>CFBundleShortVersionString</key>\s*<string>1\.3\.4</string>`,
		`<key>CFBundleIconFile</key>\s*<string>iconfile</string>`,
		// The binary is built for macOS 13 (Go 1.27 itself needs it): Finder must say so instead of letting dyld fail.
		`<key>LSMinimumSystemVersion</key>\s*<string>13\.0\.0</string>`,
		`<key>CFBundleURLSchemes</key>\s*<array>\s*<string>clarae</string>`,
	} {
		if !regexp.MustCompile(want).MatchString(plist) {
			t.Errorf("Info.plist: %s not found", want)
		}
	}

	nsh, err := render(t, "windows/installer/wails_tools.nsh", "-version", version)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`!define INFO_PROJECTNAME "Clarae notanda"`, // PRODUCT_EXECUTABLE = "${INFO_PROJECTNAME}.exe" = "Clarae notanda.exe"
		`!define PRODUCT_EXECUTABLE "${INFO_PROJECTNAME}.exe"`,
		`!define INFO_COMPANYNAME "E2BR-Advisory Sagl"`,
		`!define INFO_PRODUCTNAME "Clarae notanda"`,
		`!define UNINST_KEY_NAME "${INFO_COMPANYNAME}${INFO_PRODUCTNAME}"`,
		`!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINST_KEY_NAME}"`,
		`!insertmacro CUSTOM_PROTOCOL_ASSOCIATE "clarae"`,
		`!insertmacro CUSTOM_PROTOCOL_UNASSOCIATE "clarae"`,
		`WriteRegStr SHELL_CONTEXT "Software\Classes\${PROTOCOL}\shell\open\command" "" "${COMMAND}"`,
	} {
		if !strings.Contains(nsh, want) {
			t.Errorf("wails_tools.nsh: %q not found", want)
		}
	}

	manifest, err := render(t, "windows/wails.exe.manifest", "-version", version)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifest, `name="com.wails.Clarae notanda" version="1.3.4.0"`) {
		t.Errorf("manifest: assemblyIdentity is not name+four-part version:\n%s", manifest)
	}

	info, err := render(t, "windows/info.json", "-version", version)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Fixed struct {
			FileVersion string `json:"file_version"`
		} `json:"fixed"`
		Info map[string]map[string]string `json:"info"`
	}
	if err := json.Unmarshal([]byte(info), &parsed); err != nil {
		t.Fatalf("info.json is not JSON: %v\n%s", err, info)
	}
	if parsed.Fixed.FileVersion != version || parsed.Info["0000"]["ProductName"] != "Clarae notanda" || parsed.Info["0000"]["CompanyName"] != "E2BR-Advisory Sagl" {
		t.Errorf("info.json: unexpected content %+v", parsed)
	}
}

// TestInstallerOutputName pins the installer file name (release.yml, package scripts and the updater's
// clarae-<version>-<os>-<arch>.<ext> look for it) and the WebView2 data path the uninstaller removes.
func TestInstallerOutputName(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot(), "apps", "desktop", "build", "windows", "installer", "project.nsi"))
	if err != nil {
		t.Fatal(err)
	}
	nsi := string(raw)
	for _, want := range []string{
		`OutFile "..\..\bin\clarae-${ARCH}-installer.exe"`,
		`InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}"`,
		`RMDir /r "$AppData\${PRODUCT_EXECUTABLE}"`,
	} {
		if !strings.Contains(nsi, want) {
			t.Errorf("project.nsi: %q not found", want)
		}
	}
}

func TestProjectFields(t *testing.T) {
	for field, want := range map[string]string{"name": "Clarae notanda", "outputfilename": "clarae", "productname": "Clarae notanda"} {
		cmd := exec.Command(renderTool(t), "-project", projectJSON(), "-field", field) //nolint:gosec // the tool built above
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("-field %s: %v", field, err)
		}
		if got := strings.TrimSpace(string(out)); got != want {
			t.Errorf("-field %s = %q, want %q", field, got, want)
		}
	}
}

func TestRenderRefusesWithoutVersionAndKeepsTheTemplate(t *testing.T) {
	// No version: project.json does not carry one and the build always stamps it.
	if out, err := render(t, "darwin/Info.plist"); err == nil {
		t.Fatalf("rendering without -version succeeded:\n%s", out)
	}

	// A template with an unknown field fails and, rendered over itself, is left untouched.
	tpl := filepath.Join(t.TempDir(), "bad.tpl")
	const content = "name={{.Name}} nope={{.Nope}}\n"
	if err := os.WriteFile(tpl, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(renderTool(t), "-project", projectJSON(), "-version", version, "-out", tpl, tpl) //nolint:gosec // the tool built above
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("a template with an unknown field rendered:\n%s", out)
	}
	after, err := os.ReadFile(tpl)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != content {
		t.Errorf("the template was changed by a failed render: %q", after)
	}
}
