//go:build !js

package telemetry

import (
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/rs/zerolog"
	"gopkg.in/natefinch/lumberjack.v2"
)

// NewLogger writes JSON lines to <dataDir>/logs/clarae.log (rotated at 10 MB,
// 5 files kept) and, when console is true, also to stderr for development.
func NewLogger(dataDir, level string, console bool) (zerolog.Logger, io.Closer, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "logs"), 0o700); err != nil {
		return zerolog.Nop(), nil, err
	}
	file := &lumberjack.Logger{
		Filename:   filepath.Join(dataDir, "logs", "clarae.log"),
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
