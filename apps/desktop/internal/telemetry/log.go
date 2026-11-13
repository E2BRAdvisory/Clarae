//go:build !js

package telemetry

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"gopkg.in/natefinch/lumberjack.v2"
)

// NewLogger writes JSON lines to <dataDir>/logs/clarae.log (rotated at 10 MB,
// 5 files kept) and, when console is true, also to stderr for development.
func NewLogger(dataDir, level string, console bool) (zerolog.Logger, io.Closer, error) {
	logs := filepath.Join(dataDir, "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		return zerolog.Nop(), nil, err
	}
	adoptLegacyLogs(logs)
	file := &lumberjack.Logger{
		Filename:   filepath.Join(logs, "clarae.log"),
		MaxSize:    10,
		MaxBackups: 5,
		MaxAge:     30,
		Compress:   true,
	}
	var w io.Writer = file
	if console {
		w = zerolog.MultiLevelWriter(file, zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.Kitchen})
	}
	lvl, err := zerolog.ParseLevel(level)
	if err != nil {
		lvl = zerolog.InfoLevel
	}
	zerolog.TimeFieldFormat = time.RFC3339Nano
	return zerolog.New(w).Level(lvl).With().Timestamp().Logger(), file, nil
}

// legacyLogPrefix is the name of the logs of 1.x: <prefix>.log, and the rotated backups
// <prefix>-<time>.log[.gz]. Dropped in 3.0.
const legacyLogPrefix = "memobrain"

// adoptLegacyLogs renames the logs of 1.x to the names the logger rotates now, so that the history carries on
// and the old files age out with the new ones, instead of staying for good. A destination that
// exists is left alone, and nothing is overwritten. Best effort: a log is not worth stopping for.
// Dropped in 3.0.
func adoptLegacyLogs(logs string) {
	entries, err := os.ReadDir(logs)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		var renamed string
		switch {
		case name == legacyLogPrefix+".log":
			renamed = "clarae.log"
		case strings.HasPrefix(name, legacyLogPrefix+"-") && (strings.HasSuffix(name, ".log") || strings.HasSuffix(name, ".log.gz")):
			renamed = "clarae-" + strings.TrimPrefix(name, legacyLogPrefix+"-")
		default:
			continue
		}
		dst := filepath.Join(logs, renamed)
		if _, err := os.Lstat(dst); err == nil {
			continue
		}
		_ = os.Rename(filepath.Join(logs, name), dst)
	}
}
