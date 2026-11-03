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
