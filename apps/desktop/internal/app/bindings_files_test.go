package app

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// filesHost records what the file bindings hand to the system.
type filesHost struct {
	Host
	opened, revealed, delivered []string
	saveTo                      string // the path the "save as" dialog answers ("" = cancelled)
}

func (h *filesHost) OpenPath(_ context.Context, p string) error {
	h.opened = append(h.opened, p)
	return nil
}

func (h *filesHost) RevealPath(_ context.Context, p string) error {
	h.revealed = append(h.revealed, p)
	return nil
}

func (h *filesHost) SaveFile(context.Context, SaveDialog) (string, error) { return h.saveTo, nil }
func (h *filesHost) Delivered(_ context.Context, p string)                { h.delivered = append(h.delivered, p) }

func newFilesApp(t *testing.T) (*VaultAPI, *filesHost, string, string) {
	t.Helper()
	a, info, root := newTestApp(t)
	h := &filesHost{Host: a.host}
	a.host = h
	return NewVaultAPI(a), h, info.ID, root
}

// errorCodeOf is the code of a binding error ("" for nil or an uncoded error).
func errorCodeOf(err error) string {
	if err == nil {
		return ""
	}
	code, _, ok := strings.Cut(err.Error(), ": ")
	if !ok {
		return ""
	}
	return code
}

func writeVaultFile(t *testing.T, root, rel string, mode os.FileMode) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("data of "+rel), mode); err != nil {
		t.Fatal(err)
	}
}

func TestOpenWithSystemAppHandsTheFileToTheSystem(t *testing.T) {
	v, h, id, root := newFilesApp(t)
	writeVaultFile(t, root, "Docs/Report.docx", 0o644)
	if err := v.OpenWithSystemApp(id, "Docs/Report.docx"); err != nil {
		t.Fatal(err)
	}
	if len(h.opened) != 1 || !strings.HasSuffix(filepath.ToSlash(h.opened[0]), "/Docs/Report.docx") || !filepath.IsAbs(h.opened[0]) {
		t.Fatalf("opened %v, want the absolute path of Docs/Report.docx", h.opened)
	}
}

func TestOpenWithSystemAppRefusesProgramsFoldersAndEscapes(t *testing.T) {
	v, h, id, root := newFilesApp(t)
	writeVaultFile(t, root, "tools/setup.exe", 0o644)
	writeVaultFile(t, root, "tools/Deploy.command", 0o644)
	writeVaultFile(t, root, "Tool.app/Contents/Info.plist", 0o644)
	for _, rel := range []string{"tools/setup.exe", "tools/Deploy.command"} {
		if err := v.OpenWithSystemApp(id, rel); errorCodeOf(err) != ErrCodeExecutable {
			t.Errorf("%s: err %v, want code %s", rel, err, ErrCodeExecutable)
		}
	}
	if err := v.OpenWithSystemApp(id, "Tool.app"); errorCodeOf(err) != ErrCodeInvalidPath {
		t.Errorf("a folder: err %v, want code %s", err, ErrCodeInvalidPath)
	}
	if err := v.OpenWithSystemApp(id, "../outside.zip"); errorCodeOf(err) != ErrCodeInvalidPath {
		t.Errorf("a path outside the vault: err %v, want code %s", err, ErrCodeInvalidPath)
	}
	if err := v.OpenWithSystemApp(id, "missing.zip"); errorCodeOf(err) != ErrCodeNotFound {
		t.Errorf("a missing file: err %v, want code %s", err, ErrCodeNotFound)
	}
	if len(h.opened) != 0 {
		t.Fatalf("refused files reached the system: %v", h.opened)
	}
	// A program can still be shown in the file manager.
	if err := v.RevealInFolder(id, "tools/setup.exe"); err != nil || len(h.revealed) != 1 {
		t.Fatalf("reveal: err %v, revealed %v", err, h.revealed)
	}
}

func TestOpenWithSystemAppRefusesAnExtensionlessProgram(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no execute bit")
	}
	v, h, id, root := newFilesApp(t)
	writeVaultFile(t, root, "bin/run", 0o755)
	writeVaultFile(t, root, "LICENSE", 0o644)
	writeVaultFile(t, root, "notes.txt", 0o755) // opens by its type, whatever the mode
	if err := v.OpenWithSystemApp(id, "bin/run"); errorCodeOf(err) != ErrCodeExecutable {
		t.Errorf("bin/run: err %v, want code %s", err, ErrCodeExecutable)
	}
	for _, rel := range []string{"LICENSE", "notes.txt"} {
		if err := v.OpenWithSystemApp(id, rel); err != nil {
			t.Errorf("%s: %v", rel, err)
		}
	}
	if len(h.opened) != 2 {
		t.Fatalf("opened %v", h.opened)
	}
}

func TestDownloadFileCopiesOutsideTheVault(t *testing.T) {
	v, h, id, root := newFilesApp(t)
	writeVaultFile(t, root, "Archive/data.zip", 0o644)

	h.saveTo = "" // cancelled
	if res, err := v.DownloadFile(id, "Archive/data.zip"); err != nil || !res.Cancelled {
		t.Fatalf("cancelled: %+v, %v", res, err)
	}

	h.saveTo = filepath.Join(t.TempDir(), "data.zip")
	res, err := v.DownloadFile(id, "Archive/data.zip")
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(h.saveTo)
	if err != nil || string(got) != "data of Archive/data.zip" || res.Bytes != int64(len(got)) {
		t.Fatalf("copy %q (%v), result %+v", got, err, res)
	}
	if len(h.delivered) != 1 || h.delivered[0] != h.saveTo {
		t.Fatalf("delivered %v, want %s", h.delivered, h.saveTo)
	}

	h.saveTo = filepath.Join(root, "copy.zip")
	if _, err := v.DownloadFile(id, "Archive/data.zip"); err == nil {
		t.Fatal("a copy inside the vault was accepted")
	}
}
