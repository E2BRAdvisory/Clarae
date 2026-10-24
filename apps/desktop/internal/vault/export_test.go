package vault

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for p, c := range files {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExportZipRoundTrip(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"Home.md":                "# Home",
		"Notes/déjà vu.md":       "accents",
		"Notes/deep/x.json":      `{"a":1}`,
		"Attachments/pic.png":    "\x89PNG-fake",
		".nodus/editor.json":     `{"fontSize":14}`,
		".nodus/workspace.json":  "device",
		".nodus/cache/thumb.svg": "cache",
		".trash/Old.md":          "deleted",
		"Notes/.DS_Store":        "junk",
	}
	writeTree(t, root, files)
	if err := os.MkdirAll(filepath.Join(root, "Empty", "Folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	fsys, err := NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	st, err := fsys.ExportZip(context.Background(), &buf)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("invalid zip: %v", err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		got[f.Name] = string(b)
	}
	for p, want := range map[string]string{
		"Home.md": "# Home", "Notes/déjà vu.md": "accents", "Notes/deep/x.json": `{"a":1}`,
		"Attachments/pic.png": "\x89PNG-fake", ".nodus/editor.json": `{"fontSize":14}`,
	} {
		if got[p] != want {
			t.Errorf("%s = %q, want %q", p, got[p], want)
		}
	}
	for _, absent := range []string{".nodus/workspace.json", ".nodus/cache/thumb.svg", ".trash/Old.md", ".trash/", "Notes/.DS_Store"} {
		if _, ok := got[absent]; ok {
			t.Errorf("%s must not be exported", absent)
		}
	}
	if _, ok := got["Empty/Folder/"]; !ok {
		t.Error("an empty folder was lost")
	}
	if st.Files != 5 || st.Bytes == 0 {
		t.Errorf("stats: %+v", st)
	}
}

func TestExportZipStopsWhenCancelled(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{"a.md": "a", "b.md": "b"})
	fsys, _ := NewFS(root)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fsys.ExportZip(ctx, io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}
