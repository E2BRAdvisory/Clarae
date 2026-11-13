package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clarae/shared/envcompat"
)

// The data directory of 1.x (ADR-0052): what the first start of this version does with it.

// layout builds the folders of a test: base plays the user config dir.
type layout struct {
	t    *testing.T
	base string
}

func newLayout(t *testing.T) layout {
	t.Helper()
	// The data directory is looked up in the environment first: a developer's own must not leak in.
	t.Setenv(envcompat.Prefix+DataDirEnvName, "")
	t.Setenv(envcompat.LegacyPrefix+DataDirEnvName, "")
	return layout{t: t, base: t.TempDir()}
}

func (l layout) newDir() string          { return filepath.Join(l.base, appDirName) }
func (l layout) legacyDir() string       { return filepath.Join(l.base, legacyAppDirName) }
func (l layout) config() (string, error) { return l.base, nil }

func (l layout) write(path, content string) {
	l.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		l.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		l.t.Fatal(err)
	}
}

func (l layout) read(path string) string {
	l.t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		l.t.Fatal(err)
	}
	return string(b)
}

func (l layout) exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// legacyFiles is a data directory of 1.x as a clean exit leaves it.
func (l layout) legacyFiles() {
	l.write(filepath.Join(l.legacyDir(), "app.db"), "legacy-db")
	l.write(filepath.Join(l.legacyDir(), "auth.json"), "legacy-session")
	l.write(filepath.Join(l.legacyDir(), "mounts", "share1", "note.md"), "shared note")
	l.write(filepath.Join(l.legacyDir(), "kept", "old", "n.md"), "kept note")
	l.write(filepath.Join(l.legacyDir(), "logs", "app.log"), "log")
}

func quiet(string) error { return nil }

func busy(string) error { return errInUse }

func noteTexts(info DataDirInfo) string {
	var out []string
	for _, n := range info.Notes {
		out = append(out, n.Msg)
	}
	return strings.Join(out, "\n")
}

func failIfProbed(t *testing.T) func(string) error {
	return func(string) error {
		t.Helper()
		t.Error("the old database was probed: nothing is to be moved")
		return nil
	}
}

func TestOnlyTheOldDirectoryIsMoved(t *testing.T) {
	l := newLayout(t)
	l.legacyFiles()
	info, err := resolveDataDir("", l.config, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if info.Dir != l.newDir() || info.LegacyDir != l.legacyDir() || info.Explicit || !info.Migrated {
		t.Fatalf("info = %+v", info)
	}
	if l.exists(l.legacyDir()) {
		t.Fatal("the old directory is still there")
	}
	for path, want := range map[string]string{
		"app.db":                "legacy-db",
		"auth.json":             "legacy-session",
		"mounts/share1/note.md": "shared note",
		"kept/old/n.md":         "kept note",
		"logs/app.log":          "log",
	} {
		if got := l.read(filepath.Join(l.newDir(), filepath.FromSlash(path))); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
	if !strings.Contains(noteTexts(info), "moved the data directory") {
		t.Fatalf("notes: %v", info.Notes)
	}
}

func TestTheNewDirectoryWinsAndTheOldOneIsLeftAlone(t *testing.T) {
	l := newLayout(t)
	l.legacyFiles()
	l.write(filepath.Join(l.newDir(), "app.db"), "new-db")
	info, err := resolveDataDir("", l.config, failIfProbed(t))
	if err != nil {
		t.Fatal(err)
	}
	if info.Migrated || l.read(filepath.Join(l.newDir(), "app.db")) != "new-db" {
		t.Fatalf("info = %+v", info)
	}
	if l.read(filepath.Join(l.legacyDir(), "app.db")) != "legacy-db" || !l.exists(filepath.Join(l.legacyDir(), "mounts")) {
		t.Fatal("the old directory was touched")
	}
	if info.LegacyDir != l.legacyDir() || !strings.Contains(noteTexts(info), "is still at") {
		t.Fatalf("the old directory must be reported: %+v", info)
	}
}

func TestNeitherDirectoryMakesANewOne(t *testing.T) {
	l := newLayout(t)
	info, err := resolveDataDir("", l.config, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if !l.exists(l.newDir()) || info.Migrated || len(info.Notes) != 0 || info.LegacyDir != l.legacyDir() {
		t.Fatalf("info = %+v", info)
	}
	if l.exists(l.legacyDir()) {
		t.Fatal("the old directory was created")
	}
}

func TestAFileWithTheOldNameIsNotAnOldDirectory(t *testing.T) {
	l := newLayout(t)
	l.write(l.legacyDir(), "not a folder")
	info, err := resolveDataDir("", l.config, quiet)
	if err != nil || info.Migrated || l.read(l.legacyDir()) != "not a folder" {
		t.Fatalf("info = %+v, err = %v", info, err)
	}
}

// A data directory that was asked for is used as it is: the developer who runs two devices on one
// machine must not have either of them take over the folder of the installed application.
func TestAnExplicitDirectoryMigratesNothing(t *testing.T) {
	for _, tc := range []struct {
		name  string
		set   func(t *testing.T, dir string) string // sets the environment, returns the flag
		warns bool
	}{
		{"flag", func(_ *testing.T, dir string) string { return dir }, false},
		{"current prefix", func(t *testing.T, dir string) string { t.Setenv(envcompat.Prefix+DataDirEnvName, dir); return "" }, false},
		{"legacy prefix", func(t *testing.T, dir string) string { t.Setenv(envcompat.LegacyPrefix+DataDirEnvName, dir); return "" }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := newLayout(t)
			l.legacyFiles()
			want := filepath.Join(t.TempDir(), "elsewhere")
			flag := tc.set(t, want)
			info, err := resolveDataDir(flag, l.config, failIfProbed(t))
			if err != nil {
				t.Fatal(err)
			}
			if info.Dir != want || !info.Explicit || info.Migrated || info.LegacyDir != "" {
				t.Fatalf("info = %+v", info)
			}
			if !l.exists(want) || l.read(filepath.Join(l.legacyDir(), "app.db")) != "legacy-db" || l.exists(l.newDir()) {
				t.Fatal("folders were created or moved")
			}
			if got := strings.Contains(noteTexts(info), "deprecated"); got != tc.warns {
				t.Fatalf("deprecation warning = %v, notes: %v", got, info.Notes)
			}
		})
	}
}

func TestTheFlagBeatsTheEnvironmentAndTheNewNameBeatsTheOld(t *testing.T) {
	l := newLayout(t)
	a, b, c := filepath.Join(t.TempDir(), "a"), filepath.Join(t.TempDir(), "b"), filepath.Join(t.TempDir(), "c")
	t.Setenv(envcompat.Prefix+DataDirEnvName, b)
	t.Setenv(envcompat.LegacyPrefix+DataDirEnvName, c)
	if info, err := resolveDataDir(a, l.config, quiet); err != nil || info.Dir != a {
		t.Fatalf("flag: %+v %v", info, err)
	}
	info, err := resolveDataDir("", l.config, quiet)
	if err != nil || info.Dir != b || strings.Contains(noteTexts(info), "deprecated") {
		t.Fatalf("new name: %+v %v", info, err)
	}
}

// 1.x is running: nothing is touched, and the error says so for the dialog.
func TestARunningOldInstanceStopsTheMigration(t *testing.T) {
	l := newLayout(t)
	l.legacyFiles()
	info, err := resolveDataDir("", l.config, busy)
	var le *LegacyDataDirError
	if !errors.As(err, &le) || !le.InUse || le.Legacy != l.legacyDir() {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(le.UserMessage(), "Close "+legacyProductName) {
		t.Fatalf("message: %q", le.UserMessage())
	}
	if info.Migrated || l.exists(l.newDir()) || l.read(filepath.Join(l.legacyDir(), "app.db")) != "legacy-db" {
		t.Fatalf("the folders were touched: %+v", info)
	}
}

// A database that cannot be read cannot be in use: the folder is moved and the fact is logged.
func TestAnUnreadableOldDatabaseDoesNotBlockTheMigration(t *testing.T) {
	l := newLayout(t)
	l.legacyFiles()
	info, err := resolveDataDir("", l.config, func(string) error { return errors.New("file is not a database") })
	if err != nil || !info.Migrated {
		t.Fatalf("info = %+v, err = %v", info, err)
	}
	if !strings.Contains(noteTexts(info), "could not be checked") {
		t.Fatalf("notes: %v", info.Notes)
	}
}

// An old folder without a database has no instance to ask about.
func TestAnOldDirectoryWithoutADatabaseIsMovedWithoutAProbe(t *testing.T) {
	l := newLayout(t)
	l.write(filepath.Join(l.legacyDir(), "logs", "app.log"), "log")
	info, err := resolveDataDir("", l.config, failIfProbed(t))
	if err != nil || !info.Migrated || l.read(filepath.Join(l.newDir(), "logs", "app.log")) != "log" {
		t.Fatalf("info = %+v, err = %v", info, err)
	}
}

// The rename is refused (Windows, a file held open): the user is told, and the old folder is intact.
func TestAFailedRenameStopsTheMigration(t *testing.T) {
	l := newLayout(t)
	l.legacyFiles()
	boom := errors.New("the process cannot access the file because it is being used by another process")
	old := rename
	rename = func(string, string) error { return boom }
	t.Cleanup(func() { rename = old })
	_, err := resolveDataDir("", l.config, quiet)
	var le *LegacyDataDirError
	if !errors.As(err, &le) || le.InUse || !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(le.UserMessage(), boom.Error()) {
		t.Fatalf("message: %q", le.UserMessage())
	}
	if l.exists(l.newDir()) || l.read(filepath.Join(l.legacyDir(), "app.db")) != "legacy-db" {
		t.Fatal("the folders were touched")
	}
}

// The new folder exists already (a log of this version, say) and has no app.db: the entries move one
// by one with app.db last, and a move that stops half way is resumed at the next start.
func TestAMigrationThatStopsHalfWayIsResumed(t *testing.T) {
	l := newLayout(t)
	l.legacyFiles()
	l.write(filepath.Join(l.legacyDir(), "app.db-wal"), "wal")
	l.write(filepath.Join(l.newDir(), "logs", "clarae.log"), "new log")

	var moved []string
	var failAt string
	old := rename
	rename = func(src, dst string) error {
		if filepath.Base(src) == failAt {
			return errors.New("disk is gone")
		}
		moved = append(moved, filepath.Base(src))
		return old(src, dst)
	}
	t.Cleanup(func() { rename = old })

	failAt = "app.db"
	if _, err := resolveDataDir("", l.config, quiet); err == nil {
		t.Fatal("expected the failure at app.db")
	}
	if l.exists(filepath.Join(l.newDir(), "app.db")) {
		t.Fatal("app.db was moved before the failure")
	}
	for _, name := range []string{"auth.json", "mounts", "kept", "app.db-wal"} {
		if !l.exists(filepath.Join(l.newDir(), name)) {
			t.Fatalf("%s was not moved before app.db (moved: %v)", name, moved)
		}
	}
	if moved[len(moved)-1] != "app.db-wal" {
		t.Fatalf("the sidecar of app.db must be the last one before it: %v", moved)
	}

	failAt = ""
	info, err := resolveDataDir("", l.config, quiet)
	if err != nil || !info.Migrated {
		t.Fatalf("resume: %+v, %v", info, err)
	}
	if l.read(filepath.Join(l.newDir(), "app.db")) != "legacy-db" {
		t.Fatal("app.db was not moved by the resume")
	}
	if l.read(filepath.Join(l.newDir(), "logs", "clarae.log")) != "new log" || l.read(filepath.Join(l.newDir(), "logs", "app.log")) != "log" {
		t.Fatal("the logs were not merged")
	}
	if l.exists(l.legacyDir()) {
		t.Fatal("the old directory is empty now and should be gone")
	}
	// With app.db in the new folder the next start has nothing left to do.
	info, err = resolveDataDir("", l.config, failIfProbed(t))
	if err != nil || info.Migrated {
		t.Fatalf("third start: %+v, %v", info, err)
	}
}

// Nothing is ever overwritten: a file in both places stays where it is in both.
func TestAConflictKeepsBothFiles(t *testing.T) {
	l := newLayout(t)
	l.legacyFiles()
	l.write(filepath.Join(l.newDir(), "auth.json"), "new-session")
	l.write(filepath.Join(l.newDir(), "mounts", "share2", "x.md"), "other share")
	info, err := resolveDataDir("", l.config, quiet)
	if err != nil || !info.Migrated {
		t.Fatalf("info = %+v, err = %v", info, err)
	}
	if l.read(filepath.Join(l.newDir(), "auth.json")) != "new-session" || l.read(filepath.Join(l.legacyDir(), "auth.json")) != "legacy-session" {
		t.Fatal("a file that exists in both places was overwritten or lost")
	}
	if l.read(filepath.Join(l.newDir(), "mounts", "share1", "note.md")) != "shared note" || l.read(filepath.Join(l.newDir(), "mounts", "share2", "x.md")) != "other share" {
		t.Fatal("the mounts were not merged")
	}
	if !strings.Contains(noteTexts(info), "left "+filepath.Join(l.legacyDir(), "auth.json")) {
		t.Fatalf("notes: %v", info.Notes)
	}
	if l.read(filepath.Join(l.newDir(), "app.db")) != "legacy-db" {
		t.Fatal("app.db was not moved")
	}
}

// --- the web view profile and the old application ----------------------------------------------

func TestTheWebViewProfileOf1xIsAdopted(t *testing.T) {
	l := newLayout(t)
	appData := filepath.Join(l.base, "Roaming")
	l.write(filepath.Join(appData, legacyWebViewDirNames[0], "EBWebView", "Default", "Local Storage", "leveldb", "000003.log"), "storage")
	dataDir := filepath.Join(l.base, "data")
	notes := AdoptLegacyWebViewData(dataDir, appData)
	if len(notes) != 1 || notes[0].Warn {
		t.Fatalf("notes: %+v", notes)
	}
	if got := l.read(filepath.Join(WebViewDataDir(dataDir), "EBWebView", "Default", "Local Storage", "leveldb", "000003.log")); got != "storage" {
		t.Fatalf("storage = %q", got)
	}
	if l.exists(filepath.Join(appData, legacyWebViewDirNames[0])) {
		t.Fatal("the old profile is still there")
	}
	if notes := AdoptLegacyWebViewData(dataDir, appData); len(notes) != 0 {
		t.Fatalf("second run: %+v", notes)
	}
}

func TestAWebViewProfileThatExistsIsNotReplaced(t *testing.T) {
	l := newLayout(t)
	appData := filepath.Join(l.base, "Roaming")
	l.write(filepath.Join(appData, legacyWebViewDirNames[0], "f"), "old")
	dataDir := filepath.Join(l.base, "data")
	l.write(filepath.Join(WebViewDataDir(dataDir), "f"), "new")
	if notes := AdoptLegacyWebViewData(dataDir, appData); len(notes) != 0 {
		t.Fatalf("notes: %+v", notes)
	}
	if l.read(filepath.Join(WebViewDataDir(dataDir), "f")) != "new" || l.read(filepath.Join(appData, legacyWebViewDirNames[0], "f")) != "old" {
		t.Fatal("a profile was replaced")
	}
}

// The old application has the profile open (Windows): it stays where it is and the start goes on.
func TestAWebViewProfileInUseStaysWhereItIs(t *testing.T) {
	l := newLayout(t)
	appData := filepath.Join(l.base, "Roaming")
	l.write(filepath.Join(appData, legacyWebViewDirNames[0], "f"), "old")
	old := rename
	rename = func(string, string) error { return errors.New("used by another process") }
	t.Cleanup(func() { rename = old })
	notes := AdoptLegacyWebViewData(filepath.Join(l.base, "data"), appData)
	if len(notes) != 1 || !notes[0].Warn {
		t.Fatalf("notes: %+v", notes)
	}
	if l.read(filepath.Join(appData, legacyWebViewDirNames[0], "f")) != "old" {
		t.Fatal("the old profile was touched")
	}
}

func TestAdoptLegacyWebViewDataWithNoAppData(t *testing.T) {
	if notes := AdoptLegacyWebViewData(t.TempDir(), ""); notes != nil {
		t.Fatalf("notes: %+v", notes)
	}
}

func TestLegacyInstallNotes(t *testing.T) {
	present := func(string) bool { return true }
	absent := func(string) bool { return false }
	if n := legacyInstallNotes("darwin", present); len(n) != 1 || !n[0].Warn || !strings.Contains(n[0].Msg, "/Applications/"+legacyAppDirName+".app") {
		t.Fatalf("notes: %+v", n)
	}
	if n := legacyInstallNotes("darwin", absent); n != nil {
		t.Fatalf("notes: %+v", n)
	}
	if n := legacyInstallNotes("linux", present); n != nil {
		t.Fatalf("notes: %+v", n)
	}
}

// The names of 1.x, spelt out: the migration finds nothing, and the tests above would still pass,
// if one of them were wrong.
func TestTheNamesOf1xAreSpeltAsItSpeltThem(t *testing.T) {
	if legacyAppDirName != "MemoBrain Notes" || legacyProductName != "MemoBrain Notes" {
		t.Fatalf("data directory of 1.x: %q", legacyAppDirName)
	}
	if len(legacyWebViewDirNames) != 2 || legacyWebViewDirNames[0] != "MemoBrain Notes.exe" || legacyWebViewDirNames[1] != "memobrain.exe" {
		t.Fatalf("web view profiles of 1.x: %q", legacyWebViewDirNames)
	}
}
