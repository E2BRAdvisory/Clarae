package importer

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nodus/apps/desktop/internal/vault"
)

var fixedNow = time.Date(2024, 3, 1, 12, 0, 0, 0, time.UTC)

// newVault returns a vault FS over a fresh directory and its root.
func newVault(t *testing.T) (*vault.FS, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "vault")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	return fsys, fsys.Root()
}

func baseOpts(fsys *vault.FS) Options {
	o := Options{TargetFolder: "Imp", UseWikilinks: true}.WithSink(NewVaultSink(fsys))
	o.now = func() time.Time { return fixedNow }
	return o
}

// files lists every file under root (slash paths) with its content.
func files(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p) //nolint:gosec // test helper over a temp dir
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		out[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func doImport(t *testing.T, id, path string, opts Options) Report {
	t.Helper()
	imp, err := Get(id)
	if err != nil {
		t.Fatal(err)
	}
	rep, err := imp.Run(context.Background(), path, opts, nil)
	if err != nil {
		t.Fatalf("%s: %v", id, err)
	}
	return rep
}

func mustContain(t *testing.T, where, text string, parts ...string) {
	t.Helper()
	for _, p := range parts {
		if !strings.Contains(text, p) {
			t.Errorf("%s: missing %q in:\n%s", where, p, text)
		}
	}
}

func mustNotContain(t *testing.T, where, text string, parts ...string) {
	t.Helper()
	for _, p := range parts {
		if strings.Contains(text, p) {
			t.Errorf("%s: unexpected %q in:\n%s", where, p, text)
		}
	}
}

// zipDir packs a directory into a zip (entries keep their relative names).
func zipDir(t *testing.T, dir string) string {
	t.Helper()
	m := map[string][]byte{}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p) //nolint:gosec // test helper over a fixture dir
			rel, _ := filepath.Rel(dir, p)
			m[filepath.ToSlash(rel)] = b
		}
		return nil
	})
	return makeZip(t, m)
}

func makeZip(t *testing.T, entries map[string][]byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "x.zip")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, data := range entries {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write(data)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	return p
}

// ---- Evernote ----

func TestENEX(t *testing.T) {
	fsys, root := newVault(t)
	rep := doImport(t, "enex", "testdata/enex/sample.enex", baseOpts(fsys))
	if rep.NotesCreated != 2 || rep.AttachmentsCreated != 1 {
		t.Fatalf("counts: %+v", rep)
	}
	fl := files(t, root)
	n := fl["Imp/Shopping & errands.md"]
	mustContain(t, "enex note", n,
		"created: 2024-01-15T10:30:00Z", "updated: 2024-01-16T08:15:00Z", "tags: [home, to-do]",
		"source: https://example.com/list?a=1&b=2", "author: Ada",
		"**Buy** these things:", "- [x] Milk", "- [ ] Bread & butter", "- Apples", "  - Conference",
		"![[pixel.png]]", "[the shop](https://example.com/shop)", "Encrypted content omitted", "Plain line")
	mustNotContain(t, "enex note", n, "alert(1)", "onclick", "<script", "<div")
	if _, ok := fl["Imp/attachments/pixel.png"]; !ok {
		t.Errorf("attachment missing: %v", keys(fl))
	}
	if !strings.HasPrefix(fl["Imp/attachments/pixel.png"], "\x89PNG") {
		t.Error("attachment bytes were not decoded")
	}
	mustContain(t, "meeting", fl["Imp/Meeting notes.md"], "# Agenda", "First *item*", "| Who | What |", "| Ann | Slides |")
	found := false
	for _, w := range rep.Warnings {
		if strings.Contains(w, "encrypted") {
			found = true
		}
	}
	if !found {
		t.Errorf("no en-crypt warning: %v", rep.Warnings)
	}
	if rep.ReportPath != "Imp/Import report.md" {
		t.Errorf("report path %q", rep.ReportPath)
	}
	mustContain(t, "report", fl["Imp/Import report.md"], "Notes created: 2", "Attachments created: 1")
}

func TestENEXMarkdownLinksWhenWikilinksOff(t *testing.T) {
	fsys, root := newVault(t)
	o := baseOpts(fsys)
	o.UseWikilinks = false
	doImport(t, "enex", "testdata/enex/sample.enex", o)
	mustContain(t, "enex", files(t, root)["Imp/Shopping & errands.md"], "![pixel.png](attachments/pixel.png)")
}

func TestPreviewWritesNothing(t *testing.T) {
	fsys, root := newVault(t)
	imp, _ := Get("enex")
	pv, err := imp.Preview(context.Background(), "testdata/enex/sample.enex", baseOpts(fsys))
	if err != nil {
		t.Fatal(err)
	}
	if pv.Notes != 2 || pv.Attachments != 1 || len(pv.Titles) != 2 || pv.TargetFolder != "Imp" {
		t.Fatalf("preview: %+v", pv)
	}
	if got := files(t, root); len(got) != 0 {
		t.Fatalf("preview wrote files: %v", keys(got))
	}
}

func TestENEXRejectsExternalEntities(t *testing.T) {
	evil := `<?xml version="1.0"?>
<!DOCTYPE en-export [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>
<en-export><note><title>&xxe;</title><content><![CDATA[<en-note>&b;</en-note>]]></content></note></en-export>`
	p := filepath.Join(t.TempDir(), "evil.enex")
	if err := os.WriteFile(p, []byte(evil), 0o644); err != nil {
		t.Fatal(err)
	}
	fsys, root := newVault(t)
	imp, _ := Get("enex")
	_, err := imp.Run(context.Background(), p, baseOpts(fsys), nil)
	if err == nil {
		t.Fatal("an ENEX that uses entities must be refused")
	}
	for name, c := range files(t, root) {
		if strings.Contains(c, "root:") {
			t.Fatalf("%s leaked a local file", name)
		}
	}
}

func TestENEXSizeCap(t *testing.T) {
	fsys, _ := newVault(t)
	o := baseOpts(fsys)
	o.limits = Limits{MaxEntries: 10, MaxTotalBytes: 1 << 20, MaxEntryBytes: 1 << 10}
	imp, _ := Get("enex")
	if _, err := imp.Run(context.Background(), "testdata/enex/sample.enex", o, nil); err == nil {
		t.Fatal("a file over the cap must be refused")
	}
}

// ---- HTML ----

func TestHTMLIsSanitised(t *testing.T) {
	src := `<p onclick="x()">Hi <a href="javascript:alert(1)">link</a> <a href="  JaVaScRiPt:alert(2)">l2</a>
<img src="data:image/png;base64,AAAA"><script>evil()</script><style>*{}</style>
<iframe src="http://e"></iframe><object data="x"></object><form><input name=a></form>
<a href="https://ok.example/p?q=(1)">fine</a></p>`
	res, err := htmlToMarkdown(src, htmlHooks{})
	if err != nil {
		t.Fatal(err)
	}
	mustNotContain(t, "html", res.Markdown, "<", "javascript", "evil", "onclick", "data:")
	mustContain(t, "html", res.Markdown, "Hi link l2", "[fine](https://ok.example/p?q=%281%29)")
	got := strings.Join(res.Dropped, ",")
	for _, w := range []string{"script", "style", "iframe", "object", "form", "data-image", "unsafe-link"} {
		if !strings.Contains(got, w) {
			t.Errorf("dropped list lacks %q: %s", w, got)
		}
	}
}

// ---- Markdown / HTML folder ----

func TestMarkdownFolderWikilinks(t *testing.T) {
	fsys, root := newVault(t)
	rep := doImport(t, "markdown-folder", "testdata/mdfolder", baseOpts(fsys))
	fl := files(t, root)
	idx := fl["Imp/Index.md"]
	mustContain(t, "index", idx,
		"[[Second note#Part two]]", "![[my diagram.png]]", "[[Already wiki]]", "[Missing](nowhere.md)",
		"[site](https://example.com/a(b))", "`[code](Second.md)`", "[fenced](Index.md)")
	mustContain(t, "second", fl["Imp/Sub Folder/Second note.md"], "tags: [a]", "[[Index|index]]", "![[my diagram.png]]")
	mustContain(t, "dup", fl["Imp/Duplicate.md"], "[[Imp/Sub Folder/Duplicate|dup]]")
	page := fl["Imp/page.md"]
	mustContain(t, "html page", page, "## Heading", "[[Index|index]]", "![[my diagram.png]]", "```go", "fmt.Println")
	mustNotContain(t, "html page", page, "<script", "alert", "javascript:", "iframe", "onload", "color:red")
	if _, ok := fl["Imp/assets/my diagram.png"]; !ok {
		t.Errorf("attachment not copied: %v", keys(fl))
	}
	for name := range fl {
		if strings.Contains(name, ".obsidian") {
			t.Errorf("hidden folder imported: %s", name)
		}
	}
	if rep.LinksRewritten == 0 || rep.LinksUnresolved != 1 {
		t.Errorf("link counters: %+v", rep)
	}
}

func TestMarkdownFolderKeepsMarkdownLinks(t *testing.T) {
	fsys, root := newVault(t)
	o := baseOpts(fsys)
	o.UseWikilinks = false
	doImport(t, "markdown-folder", "testdata/mdfolder", o)
	fl := files(t, root)
	mustContain(t, "index", fl["Imp/Index.md"], "[Second note](Sub%20Folder/Second%20note.md#Part%20two)", "![diagram](assets/my%20diagram.png)")
	mustContain(t, "second", fl["Imp/Sub Folder/Second note.md"], "[index](../Index.md)", "![](../assets/my%20diagram.png)")
}

func TestMarkdownFolderAttachmentsFolderOption(t *testing.T) {
	fsys, root := newVault(t)
	o := baseOpts(fsys)
	o.AttachmentsFolder = "Files"
	doImport(t, "markdown-folder", "testdata/mdfolder", o)
	fl := files(t, root)
	if _, ok := fl["Files/my diagram.png"]; !ok {
		t.Errorf("attachments folder ignored: %v", keys(fl))
	}
}

func TestNeverOverwritesExistingNotes(t *testing.T) {
	fsys, root := newVault(t)
	if err := os.MkdirAll(filepath.Join(root, "Imp"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Imp", "Index.md"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	doImport(t, "markdown-folder", "testdata/mdfolder", baseOpts(fsys))
	fl := files(t, root)
	if fl["Imp/Index.md"] != "mine" {
		t.Fatal("an existing note was overwritten")
	}
	mustContain(t, "suffix", fl["Imp/Index (1).md"], "# Index")
	mustContain(t, "link", fl["Imp/Sub Folder/Second note.md"], "[[Index (1)|index]]")
}

func TestTargetFolderMustBeInsideTheVault(t *testing.T) {
	fsys, root := newVault(t)
	imp, _ := Get("markdown-folder")
	for _, bad := range []string{"../escape", "/abs", "a/../../b", "x\\y"} {
		o := baseOpts(fsys)
		o.TargetFolder = bad
		if _, err := imp.Run(context.Background(), "testdata/mdfolder", o, nil); err == nil {
			t.Errorf("target %q must be refused", bad)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "escape")); err == nil {
		t.Fatal("wrote outside the vault")
	}
}

func TestMarkdownFolderFromZip(t *testing.T) {
	fsys, root := newVault(t)
	z := zipDir(t, "testdata/mdfolder")
	doImport(t, "markdown-folder", z, baseOpts(fsys))
	mustContain(t, "zip", files(t, root)["Imp/Index.md"], "[[Second note#Part two]]")
}

// ---- Archive safety ----

func TestEntryNameValidation(t *testing.T) {
	bad := []string{"", "/abs.md", "../x.md", "a/../../x.md", "a\\b.md", "a/\x00b.md", "C:evil.md", "a//b.md", "..", "a/.."}
	for _, n := range bad {
		if validEntryName(n) {
			t.Errorf("%q must be rejected", n)
		}
	}
	for _, n := range []string{"a.md", "dir/a b.md", "dir/sub/", ".hidden/x", "a..b/c"} {
		if !validEntryName(n) {
			t.Errorf("%q must be accepted", n)
		}
	}
}

func TestZipSlipEntriesAreRejected(t *testing.T) {
	z := makeZip(t, map[string][]byte{
		"ok.md":           []byte("fine"),
		"../evil.md":      []byte("evil"),
		"/abs.md":         []byte("evil"),
		"a\\..\\b.md":     []byte("evil"),
		"x/../../y.md":    []byte("evil"),
		"dir/./z/../q.md": []byte("odd"),
	})
	fsys, root := newVault(t)
	rep := doImport(t, "markdown-folder", z, baseOpts(fsys))
	fl := files(t, root)
	if _, ok := fl["Imp/ok.md"]; !ok {
		t.Fatalf("the safe entry was not imported: %v", keys(fl))
	}
	for name := range fl {
		if strings.Contains(name, "evil") || strings.Contains(name, "abs") || strings.Contains(name, "y.md") {
			t.Errorf("unsafe entry imported as %s", name)
		}
	}
	parent := filepath.Dir(root)
	for _, n := range []string{"evil.md", "y.md", "abs.md"} {
		if _, err := os.Stat(filepath.Join(parent, n)); err == nil {
			t.Errorf("%s written outside the vault", n)
		}
	}
	if len(rep.Skipped) < 4 {
		t.Errorf("rejected entries must be reported as skipped: %+v", rep.Skipped)
	}
}

func TestZipBombIsRefused(t *testing.T) {
	big := bytes.Repeat([]byte{0}, 4<<20) // compresses to a few KB
	z := makeZip(t, map[string][]byte{"a.md": big, "b.md": big})
	fsys, root := newVault(t)
	o := baseOpts(fsys)
	o.limits = Limits{MaxEntries: 100, MaxTotalBytes: 6 << 20, MaxEntryBytes: 5 << 20}
	imp, _ := Get("markdown-folder")
	if _, err := imp.Run(context.Background(), z, o, nil); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("total cap: %v", err)
	}
	o.limits = Limits{MaxEntries: 100, MaxTotalBytes: 100 << 20, MaxEntryBytes: 1 << 20}
	rep, err := imp.Run(context.Background(), z, o, nil)
	if err != nil || rep.NotesCreated != 0 || len(rep.Skipped) != 2 {
		t.Fatalf("entry cap: %v %+v", err, rep)
	}
	o.limits = Limits{MaxEntries: 1, MaxTotalBytes: 100 << 20, MaxEntryBytes: 10 << 20}
	if _, err := imp.Run(context.Background(), z, o, nil); !errors.Is(err, ErrTooManyEntries) {
		t.Fatalf("entry count: %v", err)
	}
	for name := range files(t, root) {
		if name != "Imp/Import report.md" {
			t.Fatalf("content written by refused imports: %s", name)
		}
	}
}

func TestCapReaderStopsLyingHeaders(t *testing.T) {
	b := &budget{max: 1 << 20, entry: 1 << 20}
	r := &capReader{r: io.LimitReader(zeroReader{}, 5<<20), c: io.NopCloser(nil), b: b}
	if _, err := io.ReadAll(r); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("got %v", err)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestSymlinksInFoldersAreNotFollowed(t *testing.T) {
	src := t.TempDir()
	secret := filepath.Join(t.TempDir(), "secret.md")
	_ = os.WriteFile(secret, []byte("TOP SECRET"), 0o644)
	_ = os.WriteFile(filepath.Join(src, "a.md"), []byte("a"), 0o644)
	if err := os.Symlink(secret, filepath.Join(src, "link.md")); err != nil {
		t.Skip("symlinks unavailable")
	}
	fsys, root := newVault(t)
	doImport(t, "markdown-folder", src, baseOpts(fsys))
	for name, c := range files(t, root) {
		if strings.Contains(c, "SECRET") {
			t.Errorf("symlink target imported as %s", name)
		}
	}
}

func TestCancelKeepsWhatWasWritten(t *testing.T) {
	fsys, root := newVault(t)
	ctx, cancel := context.WithCancel(context.Background())
	imp, _ := Get("markdown-folder")
	n := 0
	rep, err := imp.Run(ctx, "testdata/mdfolder", baseOpts(fsys), func(done, total int, cur string) {
		if n++; n == 2 {
			cancel()
		}
	})
	if err != nil || !rep.Cancelled {
		t.Fatalf("cancel: %v %+v", err, rep)
	}
	if rep.NotesCreated >= 5 {
		t.Fatalf("everything was imported: %+v", rep)
	}
	_ = root
}

// ---- Notion ----

func checkNotion(t *testing.T, path string) {
	fsys, root := newVault(t)
	rep := doImport(t, "notion", path, baseOpts(fsys))
	fl := files(t, root)
	for _, want := range []string{"Imp/Project Plan.md", "Imp/Project Plan/Task One.md", "Imp/Project Plan/shot.png", "Imp/Tasks.md", "Imp/Tasks/Task One.md", "Imp/Tasks/Task Two.md"} {
		if _, ok := fl[want]; !ok {
			t.Errorf("missing %s in %v", want, keys(fl))
		}
	}
	for name := range fl {
		if notionIDRe.MatchString(strings.TrimSuffix(name, filepath.Ext(name))) || strings.Contains(name, "0123456789abcdef") {
			t.Errorf("id suffix kept in %s", name)
		}
	}
	mustContain(t, "plan", fl["Imp/Project Plan.md"],
		"[[Imp/Project Plan/Task One|Task One]]", "[[Tasks|Tasks DB]]", "![[shot.png]]", "https://www.notion.so/x-0123456789abcdef")
	mustContain(t, "task", fl["Imp/Project Plan/Task One.md"], "[[Project Plan|Plan]]")
	row := fl["Imp/Tasks/Task One.md"]
	mustContain(t, "row page", row, "Status: Open", "Estimate: 3", "Due: 2024-02-01", "# Task One")
	mustContain(t, "new row note", fl["Imp/Tasks/Task Two.md"], "Status: Done", "Estimate: 5.5")
	mustContain(t, "index", fl["Imp/Tasks.md"], "| Name | Status | Estimate | Due |", "[[Imp/Tasks/Task One\\|Task One]]", "| Done | 5.5 |")
	mustNotContain(t, "all.csv ignored", fl["Imp/Tasks.md"]+row, "Extra")
	if rep.NotesCreated != 5 {
		t.Errorf("notes: %+v", rep)
	}
}

func TestNotionFolder(t *testing.T) { checkNotion(t, "testdata/notion/Export-1") }
func TestNotionZip(t *testing.T)    { checkNotion(t, zipDir(t, "testdata/notion")) }

// ---- Roam ----

func TestRoam(t *testing.T) {
	fsys, root := newVault(t)
	rep := doImport(t, "roam", "testdata/roam/export.json", baseOpts(fsys))
	fl := files(t, root)
	day := fl["Imp/2024-01-05.md"]
	mustContain(t, "daily", day, "created: 2024-01-05T", "tags: [daily-note]", "- [ ] Write the report", "\t- Draft in [[Project-Alpha|Project/Alpha]]", "- [x] Send email")
	proj := fl["Imp/Project-Alpha.md"]
	mustContain(t, "project", proj, "- ## Goal", "\t- See Write the report and ", "==important==", "*slanted*", "[[multi word]]", "[[2024-01-05|alias]]")
	mustNotContain(t, "project", proj, "((", "^^", "__")
	if rep.NotesCreated != 2 || len(rep.Skipped) != 1 {
		t.Errorf("report: %+v", rep)
	}
	warned := false
	for _, w := range rep.Warnings {
		if strings.Contains(w, "block reference") && strings.Contains(w, "1 could not be resolved") {
			warned = true
		}
	}
	if !warned {
		t.Errorf("block reference warning missing: %v", rep.Warnings)
	}
}

func TestRoamDailyTitles(t *testing.T) {
	for in, want := range map[string]string{"January 5th, 2024": "2024-01-05", "December 22nd, 2023": "2023-12-22", "March 3rd, 2020": "2020-03-03", "March 11th, 2020": "2020-03-11"} {
		if got, ok := roamDate(in); !ok || got != want {
			t.Errorf("%s -> %s %v", in, got, ok)
		}
	}
	if _, ok := roamDate("Not a date"); ok {
		t.Error("false positive")
	}
}

// ---- Google Keep ----

func checkKeep(t *testing.T, path string) {
	fsys, root := newVault(t)
	o := baseOpts(fsys)
	rep := doImport(t, "google-keep", path, o)
	fl := files(t, root)
	if len(rep.Skipped) != 2 {
		t.Errorf("archived and trashed must be skipped by default: %+v", rep.Skipped)
	}
	g := fl["Imp/Groceries.md"]
	mustContain(t, "groceries", g, "- [x] Milk", "- [ ] Eggs", "tags: [home, to-buy]", "pinned: true", "color: yellow", "created: 2024-01-04T")

	fsys2, root2 := newVault(t)
	o = baseOpts(fsys2)
	o.IncludeArchived, o.IncludeTrashed = true, true
	rep = doImport(t, "google-keep", path, o)
	fl = files(t, root2)
	idea := fl["Imp/A great idea.md"]
	mustContain(t, "idea", idea, "A great idea\nwith two lines", "![[photo.jpg]]", "[Example](https://example.com)", "archived: true")
	mustNotContain(t, "idea", idea, "javascript")
	mustContain(t, "trashed", fl["Imp/Trashed one.md"], "trashed: true")
	if _, ok := fl["Imp/attachments/photo.jpg"]; !ok {
		t.Errorf("photo missing: %v", keys(fl))
	}
	if rep.NotesCreated != 3 {
		t.Errorf("notes: %d", rep.NotesCreated)
	}
}

func TestKeepFolder(t *testing.T) { checkKeep(t, "testdata/keep") }
func TestKeepZip(t *testing.T)    { checkKeep(t, zipDir(t, "testdata/keep")) }

// ---- CSV ----

func TestCSV(t *testing.T) {
	fsys, root := newVault(t)
	o := baseOpts(fsys)
	o.CSV = CSVOptions{BodyColumn: "Review"}
	rep := doImport(t, "csv", "testdata/csv/books.csv", o)
	fl := files(t, root)
	if rep.NotesCreated != 3 {
		t.Fatalf("notes: %+v", rep)
	}
	dune := fl["Imp/Dune.md"]
	mustContain(t, "dune", dune, "Author: Frank Herbert", "Pages: 412", "Read: true", "Added: 2024-01-05", "Rating: 4.5", "tags: [scifi, classic]", "Great world building")
	mustNotContain(t, "dune", dune, "Title:", "Review:")
	emma := fl["Imp/Emma.md"]
	mustContain(t, "emma", emma, "Read: false", "tags: [classic]")
	mustNotContain(t, "emma", emma, "Rating")
	var quote string
	for name, c := range fl {
		if strings.HasPrefix(name, "Imp/Quote") {
			quote = c
		}
	}
	mustContain(t, "quote", quote, "Pages: 10", "Multi\nline")

	imp, _ := Get("csv")
	pv, err := imp.Preview(context.Background(), "testdata/csv/books.csv", baseOpts(fsys))
	if err != nil || pv.Delimiter != ";" || len(pv.Columns) != 8 || pv.Columns[0] != "Title" || pv.Notes != 3 {
		t.Fatalf("preview: %+v %v", pv, err)
	}
	o.CSV = CSVOptions{TitleColumn: "Nope"}
	if _, err := imp.Run(context.Background(), "testdata/csv/books.csv", o, nil); err == nil {
		t.Error("unknown title column must be refused")
	}
}

func TestDelimiterDetection(t *testing.T) {
	for in, want := range map[string]string{"a,b,c\n1,2,3\n": ",", "a;b;c\n1;2;3\n": ";", "a\tb\n1\t2\n": "\t", "a|b|c\n1|2|3\n": "|", "a;b;c\n1,5;2,5;3\n": ";"} {
		if got := detectDelimiter([]byte(in)); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestInferValue(t *testing.T) {
	for in, want := range map[string]any{"12": int64(12), "-3": int64(-3), "1.5": 1.5, "true": true, "FALSE": false, "007": "007", "2024-01-31": "2024-01-31", "hello": "hello", "": nil, "1e5": "1e5"} {
		if got := inferValue(in); got != want {
			t.Errorf("%q: got %#v want %#v", in, got, want)
		}
	}
}

// ---- Bear ----

func checkBear(t *testing.T, path string) {
	fsys, root := newVault(t)
	doImport(t, "bear", path, baseOpts(fsys))
	fl := files(t, root)
	trip := fl["Imp/Trip plan.md"]
	mustContain(t, "trip", trip, "tags: [travel, europe/italy, multi-word]", "created: 2024-01-10T08:00:00Z", "updated: 2024-01-11T09:30:00Z",
		"Pack #multi-word things.", "![[map.png]]", "#notatag")
	if strings.Contains(strings.SplitN(trip, "---\n", 3)[1], "notatag") {
		t.Error("a tag inside code was extracted")
	}
	if _, ok := fl["Imp/attachments/map.png"]; !ok {
		t.Errorf("asset missing: %v", keys(fl))
	}
	mustContain(t, "shopping", fl["Imp/Shopping.md"], "tags: [home]", "- [ ] eggs #home")
}

func TestBearFolderOfTextbundles(t *testing.T) { checkBear(t, "testdata/bear") }
func TestBearBackupZip(t *testing.T)           { checkBear(t, zipDir(t, "testdata/bear")) }

func TestBearSingleTextbundleZip(t *testing.T) {
	fsys, root := newVault(t)
	z := zipDir(t, "testdata/bear/Trip plan.textbundle")
	doImport(t, "bear", z, baseOpts(fsys))
	mustContain(t, "trip", files(t, root)["Imp/Trip plan.md"], "![[map.png]]")
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---- registry and names ----

func TestDetect(t *testing.T) {
	cases := map[string]string{
		"testdata/enex/sample.enex": "enex",
		"testdata/roam/export.json": "roam",
		"testdata/csv/books.csv":    "csv",
		"testdata/keep":             "google-keep",
		"testdata/bear":             "bear",
		"testdata/notion/Export-1":  "notion",
		"testdata/mdfolder":         "markdown-folder",
	}
	for p, want := range cases {
		ids := DetectAll(p)
		if len(ids) == 0 || ids[0] != want {
			t.Errorf("%s: %v, want %s first", p, ids, want)
		}
	}
	if ids := DetectAll("testdata/enex"); len(ids) > 0 && ids[0] != "markdown-folder" && len(ids) != 0 {
		t.Logf("folder with only an ENEX: %v", ids)
	}
	if len(Sources()) != 7 {
		t.Errorf("sources: %v", Sources())
	}
}

func TestSanitizeName(t *testing.T) {
	for in, want := range map[string]string{
		"a/b\\c": "a-b-c", "..x..": "x", "": "Untitled", "CON": "CON_", "a:b*c?": "a-b-c-", "tab\there": "tab here",
		"[[x]]#^": "--x----",
	} {
		if got := sanitizeName(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
	long := strings.Repeat("é", 200)
	if got := sanitizeName(long); len(got) > maxNameBytes {
		t.Errorf("not truncated: %d", len(got))
	}
}

func TestRewriterSkipsCode(t *testing.T) {
	rw := newRewriter(true, func(s string) (target, bool) { return target{Dest: "X/" + s}, strings.HasSuffix(s, ".md") })
	in := "[a](b.md) `[c](d.md)` ``[e](f.md)``\n```\n[g](h.md)\n```\n[i](j.md)"
	out := rw.rewrite(in, "n.md", "X/n.md")
	mustContain(t, "rewrite", out, "[[b|a]]", "`[c](d.md)`", "``[e](f.md)``", "[g](h.md)", "[[j|i]]")
}
