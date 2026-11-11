// Package telemetry configures structured logging to a rotating file in the
// application data directory (NewLogger, native only: the WebAssembly core
// logs to the browser console) and routes log/slog into the application
// logger. Crash reports (opt-in) are added in M7.
package telemetry

import (
	"context"
	"log/slog"
	"strings"

	"github.com/rs/zerolog"
)

// RouteSlog makes l the destination of the default log/slog logger (and of
// the standard log package, which writes through it). The application logs
// with zerolog; packages that log with slog.Default (internal/store warns
// about the database paths of older builds) would otherwise reach stderr only,
// which nobody reads in a packaged application or a browser worker. Both
// entry points call it once at startup: the native application and the
// WebAssembly core.
func RouteSlog(l zerolog.Logger) {
	slog.SetDefault(slog.New(zerolog.NewSlogHandler(l)))
}

// UIRuntimeLogger is the logger handed to the desktop toolkit (Wails v3 Options.Logger): the
// application logger with a floor at Warn, whatever the level of l. At debug level the toolkit
// writes the arguments and the result of every binding call, passphrases and the content of private
// vaults included, and --log-level debug reaches the support bundles; the floor keeps those lines
// out of the log. The toolkit also logs, at error level, every error a binding returns to the
// frontend (a not-found, a conflict or an invalid path is an expected answer, not a failure of the
// application, and its text names paths of the vault, private ones included): those records are
// dropped too, the frontend gets the error and decides what to show. Every other warning and error
// of the toolkit still reaches the log, so a message of those must carry no secret.
func UIRuntimeLogger(l zerolog.Logger) *slog.Logger {
	return slog.New(minLevelHandler{Handler: zerolog.NewSlogHandler(l), min: slog.LevelWarn})
}

// bindingErrorPrefix starts the text the toolkit logs when a bound method returns an error
// (wails v3 pkg/application, messageprocessor_call.go: WrapBindingCallFailedErrorf wraps it in
// "Binding call failed: ..." and the HTTP transport logs the whole text at error level). The other
// failures of a call (unknown method, bad arguments, a panic) do not start with it and are kept.
const bindingErrorPrefix = "Binding call failed: Bound method returned an error"

// minLevelHandler drops the records below min and the errors returned by bound methods, before the
// wrapped handler sees them.
type minLevelHandler struct {
	slog.Handler
	min slog.Level
}

func (h minLevelHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= h.min && h.Handler.Enabled(ctx, level)
}

func (h minLevelHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level < h.min || strings.HasPrefix(r.Message, bindingErrorPrefix) {
		return nil
	}
	return h.Handler.Handle(ctx, r)
}

func (h minLevelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return minLevelHandler{Handler: h.Handler.WithAttrs(attrs), min: h.min}
}

func (h minLevelHandler) WithGroup(name string) slog.Handler {
	return minLevelHandler{Handler: h.Handler.WithGroup(name), min: h.min}
}
