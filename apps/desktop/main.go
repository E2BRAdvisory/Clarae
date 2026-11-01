// Command memobrain is the MemoBrain Notes desktop client (Wails v2: Go backend + React
// frontend). See internal/app for the composition root.
package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"memobrain/apps/desktop/internal/app"
	"memobrain/apps/desktop/internal/platform"
	"memobrain/apps/desktop/internal/telemetry"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is set at build time via -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	os.Exit(run())
}

func run() int {
	dataDirFlag := flag.String("data-dir", "", "application data directory (default $MEMOBRAIN_DATA_DIR or the OS config dir)")
	logLevel := flag.String("log-level", "info", "log level: debug|info|warn|error")
	flag.Parse()

	if *dataDirFlag != "" {
		_ = os.Setenv(platform.DataDirEnv, *dataDirFlag)
	}
	dataDir, err := platform.DataDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "memobrain: data dir:", err)
		return 1
	}
	logger, closer, err := telemetry.NewLogger(dataDir, *logLevel, Version == "dev")
	if err != nil {
		fmt.Fprintln(os.Stderr, "memobrain: logger:", err)
		return 1
	}
	defer func() { _ = closer.Close() }()

	a := app.New(app.Options{DataDir: dataDir, Logger: logger, Version: Version})

	// A memobrain:// URL on our own command line (first instance launched by the OS).
	if u, ok := platform.FindSchemeURL(os.Args[1:]); ok {
		a.HandleURL(u)
	}

	err = wails.Run(&options.App{
		Title:     "MemoBrain Notes",
		Width:     1280,
		Height:    820,
		MinWidth:  720,
		MinHeight: 480,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: cspMiddleware,
		},
		BackgroundColour: &options.RGBA{R: 30, G: 30, B: 30, A: 1},
		OnStartup:        a.Startup,
		OnDomReady:       a.DomReady,
		OnShutdown:       a.Shutdown,
		OnBeforeClose:    (&closeGuard{}).beforeClose,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               platform.InstanceID(dataDir),
			OnSecondInstanceLaunch: a.OnSecondInstance,
		},
		Mac: &mac.Options{
			OnUrlOpen:            a.HandleURL,
			TitleBar:             mac.TitleBarHiddenInset(),
			Appearance:           mac.DefaultAppearance,
			WebviewIsTransparent: false,
			About: &mac.AboutInfo{
				Title:   "MemoBrain Notes",
				Message: "Local-first notes and knowledge base\nVersion " + Version,
			},
		},
		Bind: a.Services(),
	})
	if err != nil {
		logger.Error().Err(err).Msg("wails run")
		return 1
	}
	return 0
}

// eventBeforeClose asks the frontend to write its pending edits before the app quits; it answers
// by calling the runtime Quit again (packages/workbench/src/app/lifecycle.ts).
const eventBeforeClose = "app:before-close"

// closeFlushTimeout bounds the wait for the frontend: a frontend that never answers (still loading,
// hung) does not keep the app open. The frontend gives up on its own writes a few seconds earlier.
const closeFlushTimeout = 10 * time.Second

// closeGuard holds the first close request (window closed, Cmd+Q, runtime Quit) until the frontend
// has flushed its open notes (no silent data loss, D-04). The second request quits.
type closeGuard struct {
	mu       sync.Mutex
	pending  bool
	release  bool
	answered chan struct{}
}

// beforeClose is the Wails OnBeforeClose hook: true keeps the app open. It must not block (Windows
// calls it on the UI thread), so the event is emitted and the timeout watched in goroutines.
func (g *closeGuard) beforeClose(ctx context.Context) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch {
	case g.release:
		return false
	case g.pending:
		// The frontend has flushed (or the user insists): quit.
		g.release = true
		close(g.answered)
		return false
	}
	g.pending = true
	g.answered = make(chan struct{})
	answered := g.answered
	go runtime.EventsEmit(ctx, eventBeforeClose)
	go func() {
		select {
		case <-answered:
		case <-time.After(closeFlushTimeout):
			g.mu.Lock()
			quit := !g.release
			g.release = true
			g.mu.Unlock()
			if quit {
				runtime.Quit(ctx)
			}
		}
	}()
	return true
}

// cspMiddleware sets the Content-Security-Policy on every asset response
// (strict in production builds, relaxed for the dev server of the frontend build; SPIKE-05).
func cspMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", app.ContentSecurityPolicy)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
