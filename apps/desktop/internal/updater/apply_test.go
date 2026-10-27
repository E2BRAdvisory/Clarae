package updater

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"nodus/shared/updatemanifest"
)

func TestApplyWindowsRunsInstallerSilentlyAfterExit(t *testing.T) {
	fr := &fakeRunner{}
	a := &SystemApplier{OS: "windows", Exe: `C:\Program Files\Nodus\nodus.exe`, Runner: fr}
	res, err := a.Apply(context.Background(), `C:\data\updates\nodus-1.1.0.exe`, updatemanifest.Artifact{Kind: "nsis"})
	if err != nil || res.Method != MethodInstallerOnExit || !res.Quit {
		t.Fatalf("%+v %v", res, err)
	}
	c := fr.calls[0]
	if c[0] != "cmd.exe" || !strings.Contains(c[2], `nodus-1.1.0.exe" /S`) || !strings.Contains(c[2], `start "" "C:\Program Files\Nodus\nodus.exe"`) {
		t.Fatalf("command: %v", c)
	}
}

func TestApplyAppImageReplacesInPlace(t *testing.T) {
	dir := t.TempDir()
	cur := filepath.Join(dir, "Nodus.AppImage")
	staged := filepath.Join(dir, "staged.AppImage")
	if err := os.WriteFile(cur, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staged, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &SystemApplier{OS: "linux", AppImage: cur, Runner: &fakeRunner{}}
	res, err := a.Apply(context.Background(), staged, updatemanifest.Artifact{Kind: "appimage"})
	if err != nil || res.Method != MethodReplaceFile || !res.Quit {
		t.Fatalf("%+v %v", res, err)
	}
	got, _ := os.ReadFile(cur)
	fi, _ := os.Stat(cur)
	if string(got) != "new" || fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("content %q mode %v", got, fi.Mode())
	}
	left, _ := filepath.Glob(filepath.Join(dir, ".nodus-update-*"))
	if len(left) != 0 {
		t.Fatalf("temp left: %v", left)
	}
}

func TestApplyDebAndNonAppImageOnlyReveal(t *testing.T) {
	fr := &fakeRunner{}
	a := &SystemApplier{OS: "linux", Runner: fr}
	for _, kind := range []string{"deb", "appimage"} {
		res, _ := a.Apply(context.Background(), "/data/updates/x", updatemanifest.Artifact{Kind: kind})
		if res.Method != MethodReveal || res.Quit {
			t.Fatalf("%s: %+v", kind, res)
		}
	}
}

func TestApplyMacosHelperScript(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Nodus.app")
	exe := filepath.Join(app, "Contents", "MacOS", "nodus")
	staged := filepath.Join(dir, "nodus.dmg")
	fr := &fakeRunner{}
	a := &SystemApplier{OS: "darwin", Exe: exe, Runner: fr}
	res, err := a.Apply(context.Background(), staged, updatemanifest.Artifact{Kind: "dmg"})
	if err != nil || res.Method != MethodReplaceBundle || !res.Quit {
		t.Fatalf("%+v %v", res, err)
	}
	c := fr.calls[0]
	if c[0] != "/bin/bash" || c[3] != staged || c[4] != app {
		t.Fatalf("call %v", c)
	}
	if runtime.GOOS != "windows" {
		if out, err := exec.Command("bash", "-n", c[1]).CombinedOutput(); err != nil { //nolint:gosec // syntax check of our own script
			t.Fatalf("script syntax: %s", out)
		}
	}
	// Not running from a bundle (dev, `wails dev`): fall back to revealing the dmg.
	b := &SystemApplier{OS: "darwin", Exe: "/usr/local/bin/nodus", Runner: &fakeRunner{}}
	if res, _ := b.Apply(context.Background(), staged, updatemanifest.Artifact{Kind: "dmg"}); res.Method != MethodReveal {
		t.Fatalf("%+v", res)
	}
}

func TestPreferredKinds(t *testing.T) {
	if k := (&SystemApplier{}).PreferredKinds("linux"); k[0] != "deb" {
		t.Fatal(k)
	}
	if k := (&SystemApplier{AppImage: "/x"}).PreferredKinds("linux"); k[0] != "appimage" {
		t.Fatal(k)
	}
}
