package importer

import (
	"bytes"
	"errors"
	"runtime"
	"strings"
	"testing"
)

func TestZipDotSegmentsAreNormalised(t *testing.T) {
	z := makeZip(t, map[string][]byte{
		"./Notes/a.md":     []byte("A"),
		"Notes/./b.md":     []byte("B one"),
		"Notes/b.md":       []byte("B two"),
		"./":               nil,
		"Notes/./c/./d.md": []byte("D"),
	})
	tree, err := OpenTree(z, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tree.Close() }()
	var paths []string
	for _, f := range tree.Files() {
		paths = append(paths, f.Path)
		if _, err := readAll(tree, f.Path); err != nil {
			t.Errorf("%s cannot be opened: %v", f.Path, err)
		}
	}
	if got := strings.Join(paths, ","); got != "Notes/a.md,Notes/b.md,Notes/c/d.md" {
		t.Fatalf("files: %s", got)
	}
	if rej := strings.Join(tree.Rejected(), "\n"); !strings.Contains(rej, "duplicate entry") {
		t.Fatalf("the second Notes/b.md must be refused as a duplicate: %q", rej)
	}

	fsys, root := newVault(t)
	rep := doImport(t, "markdown-folder", z, baseOpts(fsys))
	fl := files(t, root)
	for _, n := range []string{"Imp/Notes/a.md", "Imp/Notes/b.md", "Imp/Notes/c/d.md"} {
		if _, ok := fl[n]; !ok {
			t.Errorf("%s not imported: %v (failed %+v)", n, keys(fl), rep.Failed)
		}
	}
	if rep.NotesCreated != 3 || len(rep.Failed) != 0 {
		t.Fatalf("report: %+v", rep)
	}
}

func TestEntryPath(t *testing.T) {
	for in, want := range map[string]string{"./a.md": "a.md", "a/./b.md": "a/b.md", "a/b.md": "a/b.md", ".hidden/x": ".hidden/x"} {
		if got, ok := entryPath(in); !ok || got != want {
			t.Errorf("%q: %q %v", in, got, ok)
		}
	}
	for _, in := range []string{".", "./", "./.", "../a.md", "a/../b.md", ""} {
		if got, ok := entryPath(in); ok {
			t.Errorf("%q must be refused, got %q", in, got)
		}
	}
}

// Attachments are streamed to the vault; only what is converted is read whole, under MaxReadBytes.
func TestAttachmentsAreStreamedAndNotesBounded(t *testing.T) {
	big := bytes.Repeat([]byte{0}, 32<<20) // compresses to a few KB
	z := makeZip(t, map[string][]byte{
		"pic.png": big,
		"big.md":  bytes.Repeat([]byte("x"), 2<<20),
		"ok.md":   []byte("# fine\n![[pic.png]]\n"),
	})
	fsys, root := newVault(t)
	o := baseOpts(fsys)
	o.limits = Limits{MaxEntries: 100, MaxTotalBytes: 100 << 20, MaxEntryBytes: 64 << 20, MaxReadBytes: 1 << 20}
	imp, _ := Get("markdown-folder")

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	rep, err := imp.Run(t.Context(), z, o, nil)
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatal(err)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 16<<20 {
		t.Errorf("importing a 32 MiB attachment allocated %d MiB: it is not streamed", alloc>>20)
	}
	fl := files(t, root)
	if len(fl["Imp/pic.png"]) != len(big) {
		t.Fatalf("attachment: %d bytes", len(fl["Imp/pic.png"]))
	}
	if _, ok := fl["Imp/ok.md"]; !ok {
		t.Fatalf("ok.md not imported: %v", keys(fl))
	}
	if _, ok := fl["Imp/big.md"]; ok {
		t.Fatal("a note above MaxReadBytes was converted")
	}
	failed := false
	for _, f := range rep.Failed {
		if f.Source == "big.md" && strings.Contains(f.Reason, ErrTooLargeToConvert.Error()) {
			failed = true
		}
	}
	if !failed || rep.AttachmentsCreated != 1 {
		t.Fatalf("report: %+v", rep)
	}
}

func TestReadCapped(t *testing.T) {
	if b, err := readCapped(strings.NewReader("12345"), 5); err != nil || string(b) != "12345" {
		t.Fatalf("at the cap: %q %v", b, err)
	}
	if _, err := readCapped(strings.NewReader("123456"), 5); !errors.Is(err, ErrTooLargeToConvert) {
		t.Fatalf("above the cap: %v", err)
	}
	if got := (Limits{MaxEntryBytes: 10}).readBytes(); got != 10 {
		t.Fatalf("zero MaxReadBytes: %d", got)
	}
	if got := (Limits{MaxEntryBytes: 10, MaxReadBytes: 20}).readBytes(); got != 10 {
		t.Fatalf("MaxReadBytes above MaxEntryBytes: %d", got)
	}
}
