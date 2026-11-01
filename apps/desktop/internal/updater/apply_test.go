package updater

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"memobrain/shared/updatemanifest"
)

func TestApplyWindowsRunsInstallerSilentlyAfterExit(t *testing.T) {
	fr := &fakeRunner{}
	a := &SystemApplier{OS: "windows", Exe: `C:\Program Files\MemoBrain Notes\memobrain.exe`, Runner: fr}
	res, err := a.Apply(context.Background(), `C:\data\updates\memobrain-1.1.0.exe`, updatemanifest.Artifact{Kind: "nsis"})
	if err != nil || res.Method != MethodInstallerOnExit || !res.Quit {
		t.Fatalf("%+v %v", res, err)
	}
	c := fr.calls[0]
	if !strings.HasSuffix(strings.ToLower(c[0]), "powershell.exe") || c[len(c)-2] != "-Command" {
		t.Fatalf("command: %v", c)
	}
	script := c[len(c)-1]
	if !strings.Contains(script, `Start-Process -FilePath 'C:\data\updates\memobrain-1.1.0.exe' -ArgumentList '/S' -Wait`) ||
		!strings.Contains(script, `Start-Process -FilePath 'C:\Program Files\MemoBrain Notes\memobrain.exe'`) ||
		!strings.Contains(script, "Wait-Process -Id ") {
		t.Fatalf("script: %s", script)
	}
}

// The installer command line as Windows builds it from Go's arguments
// (syscall.makeCmdLine) splits back into the same arguments, and the script
// reaches PowerShell intact, whatever the paths hold: spaces, quotes, &,
// %VAR%, carets, non-ASCII.
func TestWindowsInstallerCommandLineRoundTrip(t *testing.T) {
	paths := [][2]string{
		{`C:\Users\Ada\AppData\Local\MemoBrain\updates\memobrain-1.1.0.exe`, `C:\Program Files\MemoBrain Notes\memobrain.exe`},
		{`C:\Users\O'Brien & Co\%TEMP%\up^date\setup (1).exe`, `D:\Apps\Mémo ‘Brain’\memobrain.exe`},
		{`\\server\share\dir\`, `C:\trailing\`},
	}
	for _, p := range paths {
		name, args := windowsInstallerCommand(p[0], p[1], 4242, `C:\Windows`)
		if name != `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` {
			t.Fatalf("name %q", name)
		}
		var line []byte
		for i, a := range append([]string{name}, args...) {
			if i > 0 {
				line = append(line, ' ')
			}
			line = appendWindowsArg(line, a)
		}
		if strings.Contains(string(line), `\"`) {
			t.Fatalf("escaped quote in the command line: %s", line)
		}
		got := splitWindowsCommandLine(string(line))
		want := append([]string{name}, args...)
		if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
			t.Fatalf("round trip:\n got %q\nwant %q", got, want)
		}
		script := args[len(args)-1]
		for _, path := range p {
			if !strings.Contains(script, psQuote(path)) {
				t.Fatalf("%q not quoted in %s", path, script)
			}
		}
	}
	if q := psQuote("a'b‘c"); q != "'a''b‘‘c'" {
		t.Fatalf("psQuote = %s", q)
	}
}

// appendWindowsArg is syscall.appendEscapeArg (Go 1.27, windows).
func appendWindowsArg(b []byte, s string) []byte {
	if s == "" {
		return append(b, `""`...)
	}
	needsBackslash, hasSpace := false, false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"', '\\':
			needsBackslash = true
		case ' ', '\t':
			hasSpace = true
		}
	}
	if !needsBackslash && !hasSpace {
		return append(b, s...)
	}
	if !needsBackslash {
		b = append(b, '"')
		b = append(b, s...)
		return append(b, '"')
	}
	if hasSpace {
		b = append(b, '"')
	}
	slashes := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		default:
			slashes = 0
		case '\\':
			slashes++
		case '"':
			for ; slashes > 0; slashes-- {
				b = append(b, '\\')
			}
			b = append(b, '\\')
		}
		b = append(b, c)
	}
	if hasSpace {
		for ; slashes > 0; slashes-- {
			b = append(b, '\\')
		}
		b = append(b, '"')
	}
	return b
}

// splitWindowsCommandLine follows CommandLineToArgvW (and the CRT): 2n
// backslashes before a quote give n and toggle quoting, 2n+1 give n and a
// literal quote, other backslashes are literal.
func splitWindowsCommandLine(s string) []string {
	var out []string
	var cur []byte
	inArg, quoted := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\':
			n := 0
			for i < len(s) && s[i] == '\\' {
				n++
				i++
			}
			if i < len(s) && s[i] == '"' {
				cur = append(cur, strings.Repeat("\\", n/2)...)
				if n%2 == 1 {
					cur = append(cur, '"')
				} else {
					quoted = !quoted
				}
			} else {
				cur = append(cur, strings.Repeat("\\", n)...)
				i--
			}
			inArg = true
		case c == '"':
			if quoted && i+1 < len(s) && s[i+1] == '"' {
				cur = append(cur, '"')
				i++
			} else {
				quoted = !quoted
			}
			inArg = true
		case (c == ' ' || c == '\t') && !quoted:
			if inArg {
				out = append(out, string(cur))
				cur, inArg = cur[:0], false
			}
		default:
			cur = append(cur, c)
			inArg = true
		}
	}
	if inArg {
		out = append(out, string(cur))
	}
	return out
}

func TestApplyAppImageReplacesInPlace(t *testing.T) {
	dir := t.TempDir()
	cur := filepath.Join(dir, "MemoBrain-Notes.AppImage")
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
	left, _ := filepath.Glob(filepath.Join(dir, ".memobrain-update-*"))
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
	app := filepath.Join(dir, "MemoBrain Notes.app")
	exe := filepath.Join(app, "Contents", "MacOS", "memobrain")
	staged := filepath.Join(dir, "memobrain.dmg")
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
	if runtime.GOOS != "windows" && runtime.GOOS != "js" { // js cannot start processes
		if out, err := exec.Command("bash", "-n", c[1]).CombinedOutput(); err != nil { //nolint:gosec // syntax check of our own script
			t.Fatalf("script syntax: %s", out)
		}
	}
	// Not running from a bundle (dev, `wails dev`): fall back to revealing the dmg.
	b := &SystemApplier{OS: "darwin", Exe: "/usr/local/bin/memobrain", Runner: &fakeRunner{}}
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
