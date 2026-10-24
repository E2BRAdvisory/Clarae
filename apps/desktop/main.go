// Command nodus is the Nodus desktop client (Wails v2: Go backend + React
// frontend). See internal/app for the composition root.
package main

import (
	"embed"
	"flag"
	"fmt"
	"net/http"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"nodus/apps/desktop/internal/app"
	"nodus/apps/desktop/internal/platform"
	"nodus/apps/desktop/internal/telemetry"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is set at build time via -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	os.Exit(run())
}

func run() int {
	dataDirFlag := flag.String("data-dir", "", "application data directory (default $NODUS_DATA_DIR or the OS config dir)")
	logLevel := flag.String("log-level", "info", "log level: debug|info|warn|error")
	flag.Parse()

	if *dataDirFlag != "" {
		_ = os.Setenv(platform.DataDirEnv, *dataDirFlag)
	}
	dataDir, err := platform.DataDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "nodus: data dir:", err)
		return 1
	}
	logger, closer, err := telemetry.NewLogger(dataDir, *logLevel, Version == "dev")
	if err != nil {
		fmt.Fprintln(os.Stderr, "nodus: logger:", err)
		return 1
	}
	defer func() { _ = closer.Close() }()

	a := app.New(app.Options{DataDir: dataDir, Logger: logger, Version: Version})

	// A nodus:// URL on our own command line (first instance launched by the OS).
	if u, ok := platform.FindSchemeURL(os.Args[1:]); ok {
		a.HandleURL(u)
	}

	err = wails.Run(&options.App{
		Title:     "Nodus",
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
				Title:   "Nodus",
				Message: "Local-first notes and knowledge base\nVersion " + Version,
			},
		},
		Bind: []interface{}{
			app.NewVaultAPI(a),
			app.NewSearchAPI(a),
			app.NewSettingsAPI(a),
			app.NewAuthAPI(a),
			app.NewLinksAPI(a),
			app.NewTagsAPI(a),
			app.NewPropertiesAPI(a),
		},
	})
	if err != nil {
		logger.Error().Err(err).Msg("wails run")
		return 1
	}
	return 0
}

// cspMiddleware sets the Content-Security-Policy on every asset response
// (strict in production builds, relaxed for the Vite dev server; SPIKE-05).
func cspMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", app.ContentSecurityPolicy)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
