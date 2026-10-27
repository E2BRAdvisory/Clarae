package updater

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"memobrain/shared/updatemanifest"
)

// Methods reported in Result.Method.
const (
	MethodInstallerOnExit = "installer-on-exit" // Windows: silent NSIS installer after the app exits
	MethodReplaceBundle   = "replace-bundle"    // macOS: helper script swaps the .app after exit
	MethodReplaceFile     = "replace-appimage"  // Linux: AppImage replaced in place
	MethodReveal          = "reveal"            // verified file shown in the file manager
)

// Result describes what Apply did.
type Result struct {
	Method string `json:"method"`
	// Quit is true when the application must exit now for the update to proceed.
	Quit bool `json:"quit"`
	// Path is the verified file the user can open manually.
	Path    string `json:"path"`
	Message string `json:"message"`
}

// Applier installs a staged, already verified artifact.
type Applier interface {
	// PreferredKinds lists the artifact kinds to try for an OS, best first.
	PreferredKinds(goos string) []string
	Apply(ctx context.Context, staged string, art updatemanifest.Artifact) (Result, error)
}

// Runner starts detached processes (replaced by a fake in tests).
type Runner interface {
	Start(name string, args ...string) error
}

type execRunner struct{}

func (execRunner) Start(name string, args ...string) error {
	cmd := exec.Command(name, args...) //nolint:gosec // arguments are built from verified, staged paths
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// SystemApplier applies updates for the current OS.
//
// What is automated, per platform:
//   - windows/nsis: the installer runs silently (/S) once the app has exited.
//   - darwin/dmg: a helper script waits for the app to exit, mounts the dmg,
//     verifies the new bundle with codesign/spctl, swaps the .app (keeping the
//     old one until the swap worked) and relaunches; when the bundle location
//     is not writable the dmg is simply opened.
//   - linux/appimage: when running from an AppImage ($APPIMAGE) the file is
//     replaced in place; a restart picks it up.
//   - linux/deb (and everything else): the verified file is revealed; installing
//     a package needs root and stays a user action.
type SystemApplier struct {
	OS       string
	Exe      string // path of the running executable
	AppImage string // $APPIMAGE (empty = not an AppImage)
	Runner   Runner
	// StageDir receives the macOS helper script (default: next to the staged file).
}

// NewSystemApplier builds the applier for the running process.
func NewSystemApplier() *SystemApplier {
	exe, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return &SystemApplier{OS: runtime.GOOS, Exe: exe, AppImage: os.Getenv("APPIMAGE"), Runner: execRunner{}}
}

// PreferredKinds implements Applier.
func (a *SystemApplier) PreferredKinds(goos string) []string {
	switch goos {
	case "windows":
		return []string{updatemanifest.KindNSIS}
	case "darwin":
		return []string{updatemanifest.KindDMG}
	case "linux":
		if a.AppImage != "" {
			return []string{updatemanifest.KindAppImage, updatemanifest.KindDeb}
		}
		return []string{updatemanifest.KindDeb, updatemanifest.KindAppImage}
	}
	return nil
}

// Apply implements Applier.
func (a *SystemApplier) Apply(_ context.Context, staged string, art updatemanifest.Artifact) (Result, error) {
	switch {
	case a.OS == "windows" && art.Kind == updatemanifest.KindNSIS:
		name, args := windowsInstallerCommand(staged, a.Exe)
		if err := a.Runner.Start(name, args...); err != nil {
			return a.reveal(staged, err)
		}
		return Result{Method: MethodInstallerOnExit, Quit: true, Path: staged,
			Message: "The installer starts when MemoBrain Notes has closed (Windows may ask for administrator approval)."}, nil
	case a.OS == "darwin" && art.Kind == updatemanifest.KindDMG:
		app := macAppBundle(a.Exe)
		if app == "" || !dirWritable(filepath.Dir(app)) {
			return a.reveal(staged, nil)
		}
		script := filepath.Join(filepath.Dir(staged), "apply-update.sh")
		if err := os.WriteFile(script, []byte(macHelperScript), 0o700); err != nil {
			return a.reveal(staged, err)
		}
		if err := a.Runner.Start("/bin/bash", script, fmt.Sprint(os.Getpid()), staged, app); err != nil {
			return a.reveal(staged, err)
		}
		return Result{Method: MethodReplaceBundle, Quit: true, Path: staged,
			Message: "MemoBrain Notes will restart with the new version."}, nil
	case a.OS == "linux" && art.Kind == updatemanifest.KindAppImage && a.AppImage != "":
		if err := replaceFile(staged, a.AppImage); err != nil {
			return a.reveal(staged, err)
		}
		return Result{Method: MethodReplaceFile, Quit: true, Path: a.AppImage,
			Message: "The AppImage was replaced; start MemoBrain Notes again."}, nil
	}
	return a.reveal(staged, nil)
}

// reveal shows the verified file in the file manager. cause is the reason an
// automatic method was abandoned (kept in the message, never fatal).
func (a *SystemApplier) reveal(staged string, cause error) (Result, error) {
	var name string
	var args []string
	switch a.OS {
	case "darwin":
		name, args = "open", []string{"-R", staged}
	case "windows":
		name, args = "explorer.exe", []string{"/select," + staged}
	default:
		name, args = "xdg-open", []string{filepath.Dir(staged)}
	}
	msg := "The update was downloaded and verified: install it from " + staged
	if cause != nil {
		msg += " (automatic install failed: " + cause.Error() + ")"
	}
	_ = a.Runner.Start(name, args...) // best effort: the path is in the message
	return Result{Method: MethodReveal, Path: staged, Message: msg}, nil
}

// windowsInstallerCommand waits ~3 s for the app to exit, runs the NSIS
// installer silently and starts the new executable afterwards.
func windowsInstallerCommand(installer, exe string) (string, []string) {
	script := fmt.Sprintf(`ping -n 4 127.0.0.1 >nul & "%s" /S & start "" "%s"`, installer, exe)
	return "cmd.exe", []string{"/C", script}
}

// macAppBundle returns "/Applications/MemoBrain Notes.app" for ".../MemoBrain Notes.app/Contents/MacOS/memobrain".
func macAppBundle(exe string) string {
	i := strings.Index(exe, ".app/Contents/MacOS/")
	if i < 0 {
		return ""
	}
	return exe[:i+len(".app")]
}

func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".memobrain-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// replaceFile copies src next to dst, marks it executable and renames it over dst.
func replaceFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".memobrain-update-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := io.Copy(tmp, in); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// macHelperScript runs detached after the app quits: $1 = pid to wait for,
// $2 = staged .dmg, $3 = installed .app path. On any failure the dmg is
// opened so the user can finish by hand; the old bundle is restored.
const macHelperScript = `#!/bin/bash
set -u
PID="$1"; DMG="$2"; APP="$3"
for _ in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
fallback() { /usr/bin/open "$DMG"; exit 1; }
MNT="$(mktemp -d /tmp/memobrain-update.XXXXXX)" || fallback
/usr/bin/hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null || fallback
cleanup() { /usr/bin/hdiutil detach "$MNT" >/dev/null 2>&1; rmdir "$MNT" 2>/dev/null; }
NEW="$(find "$MNT" -maxdepth 1 -name '*.app' | head -n 1)"
[ -n "$NEW" ] || { cleanup; fallback; }
/usr/bin/codesign --verify --deep --strict "$NEW" 2>/dev/null || { cleanup; fallback; }
/usr/sbin/spctl --assess --type execute "$NEW" 2>/dev/null || { cleanup; fallback; }
OLD="$APP.old-update"
rm -rf "$OLD"
mv "$APP" "$OLD" || { cleanup; fallback; }
if /usr/bin/ditto "$NEW" "$APP"; then
  rm -rf "$OLD"; cleanup; /usr/bin/open "$APP"
else
  rm -rf "$APP"; mv "$OLD" "$APP"; cleanup; fallback
fi
`
