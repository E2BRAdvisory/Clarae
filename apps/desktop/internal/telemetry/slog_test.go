package telemetry

import (
	"bytes"
	"encoding/json"
	"log"
	"log/slog"
	"testing"

	"github.com/rs/zerolog"
)

// A warning written with slog.Default lands in the application log, with its
// level and attributes, once RouteSlog has run; the level of the application
// logger still filters it.
func TestRouteSlogWritesToTheAppLogger(t *testing.T) {
	prev := slog.Default()
	prevFlags, prevOut := log.Flags(), log.Writer()
	t.Cleanup(func() {
		slog.SetDefault(prev)
		log.SetFlags(prevFlags)
		log.SetOutput(prevOut)
	})

	var buf bytes.Buffer
	RouteSlog(zerolog.New(&buf).Level(zerolog.WarnLevel))
	slog.Info("dropped: below the level of the application logger")
	slog.Warn("store: an older build kept this database at another path", "path", "/data/index.db", "legacy_path", "/data/old.db")

	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	if len(lines) != 1 {
		t.Fatalf("log lines %q, want the warning only", buf.String())
	}
	var got map[string]any
	if err := json.Unmarshal(lines[0], &got); err != nil {
		t.Fatalf("%q: %v", lines[0], err)
	}
	if got["level"] != "warn" || got["path"] != "/data/index.db" || got["legacy_path"] != "/data/old.db" ||
		got["message"] != "store: an older build kept this database at another path" {
		t.Fatalf("logged %v", got)
	}
}

// The toolkit logger never carries what a binding call is made of: a passphrase passed at debug
// level (the toolkit logs "Binding call complete" with the arguments there) must not reach the
// application log, even when the application runs at debug level.
func TestUIRuntimeLoggerKeepsBindingArgumentsOutOfTheLog(t *testing.T) {
	var buf bytes.Buffer
	l := UIRuntimeLogger(zerolog.New(&buf).Level(zerolog.DebugLevel))
	l.Debug("Binding call complete:", "args", `["correct horse battery staple"]`, "result", "null")
	l.Info("Binding call started:", "args", `["correct horse battery staple"]`)
	l.With("window", "main").WithGroup("g").Debug("again", "args", "secret")
	if buf.Len() != 0 {
		t.Fatalf("debug and info records reached the log: %s", buf.String())
	}
	l.Warn("Runtime call failed", "error", "conflict: file changed on disk")
	l.With("window", "main").Error("boom")
	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("want the warning and the error, got %d lines: %s", len(lines), buf.String())
	}
	var rec map[string]any
	if err := json.Unmarshal(lines[0], &rec); err != nil || rec["level"] != "warn" {
		t.Fatalf("first line: %s (%v)", lines[0], err)
	}
	if bytes.Contains(buf.Bytes(), []byte("correct horse")) {
		t.Fatal("the secret is in the log")
	}
}

// The error a bound method returns is an answer for the frontend, not a failure of the
// application: the toolkit logs it at error level with the text of the error, which names paths of
// the vault; at the default level it must not reach the log. The other errors of a call do.
func TestUIRuntimeLoggerDropsTheErrorsOfBoundMethods(t *testing.T) {
	var buf bytes.Buffer
	l := UIRuntimeLogger(zerolog.New(&buf).Level(zerolog.InfoLevel))
	l.Error("Binding call failed: Bound method returned an error: not-found: Secret Vault/clients/acme.md")
	l.With("window", "main").Error("Binding call failed: Bound method returned an error: conflict: Secret Vault/a.md")
	if buf.Len() != 0 {
		t.Fatalf("a binding error reached the log: %s", buf.String())
	}
	l.Error("Binding call failed: failed to call binding: unknown method")
	l.Error("panic in bound method core.Call: boom")
	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("want the two other errors, got %d lines: %s", len(lines), buf.String())
	}
	if bytes.Contains(buf.Bytes(), []byte("Secret Vault")) {
		t.Fatal("a vault path is in the log")
	}
}
