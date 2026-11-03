// Package telemetry configures structured logging to a rotating file in the
// application data directory (NewLogger, native only: the WebAssembly core
// logs to the browser console) and routes log/slog into the application
// logger. Crash reports (opt-in) are added in M7.
package telemetry

import (
	"log/slog"

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
