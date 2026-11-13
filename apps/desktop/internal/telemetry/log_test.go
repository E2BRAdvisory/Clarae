//go:build !js

package telemetry

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func listing(t *testing.T, dir string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		out[e.Name()] = string(b)
	}
	return out
}

func TestAdoptLegacyLogsRenamesTheLogAndItsBackups(t *testing.T) {
	logs := t.TempDir()
	writeFiles(t, logs, map[string]string{
		legacyLogPrefix + ".log":                            "current",
		legacyLogPrefix + "-2026-01-02T03-04-05.000.log":    "b1",
		legacyLogPrefix + "-2026-01-01T03-04-05.000.log.gz": "b2",
		"other.txt":                    "x",
		legacyLogPrefix + "-notes.txt": "y",
	})
	adoptLegacyLogs(logs)
	got := listing(t, logs)
	want := map[string]string{
		"clarae.log":                            "current",
		"clarae-2026-01-02T03-04-05.000.log":    "b1",
		"clarae-2026-01-01T03-04-05.000.log.gz": "b2",
		"other.txt":                             "x",
		legacyLogPrefix + "-notes.txt":          "y",
	}
	if len(got) != len(want) {
		t.Fatalf("files: %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
}

// Nothing is overwritten, and a second run changes nothing.
func TestAdoptLegacyLogsKeepsWhatIsAlreadyThere(t *testing.T) {
	logs := t.TempDir()
	writeFiles(t, logs, map[string]string{legacyLogPrefix + ".log": "old", "clarae.log": "new"})
	adoptLegacyLogs(logs)
	adoptLegacyLogs(logs)
	got := listing(t, logs)
	if got["clarae.log"] != "new" || got[legacyLogPrefix+".log"] != "old" || len(got) != 2 {
		t.Fatalf("files: %v", got)
	}
}

// The logger of a data directory that holds the logs of 1.x carries on with them.
func TestNewLoggerAdoptsTheLogsOf1x(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, filepath.Join(dir, "logs"), map[string]string{legacyLogPrefix + ".log": "{\"message\":\"from 1.x\"}\n"})
	logger, closer, err := NewLogger(dir, "info", false)
	if err != nil {
		t.Fatal(err)
	}
	logger.Info().Msg("from 2.x")
	_ = closer.Close()
	got := listing(t, filepath.Join(dir, "logs"))
	if _, old := got[legacyLogPrefix+".log"]; old {
		t.Fatal("the log of 1.x is still there")
	}
	content := got["clarae.log"]
	if !strings.Contains(content, "from 1.x") || !strings.Contains(content, "from 2.x") {
		t.Fatalf("clarae.log = %q", content)
	}
}

func TestTheLogNameOf1xIsSpeltAsItSpeltIt(t *testing.T) {
	if legacyLogPrefix != "memobrain" {
		t.Fatalf("legacyLogPrefix = %q", legacyLogPrefix)
	}
}
