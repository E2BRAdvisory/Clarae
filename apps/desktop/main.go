// Command clarae is the Clarae notanda desktop client (Wails v3: Go backend + React
// frontend). See internal/app for the composition root and internal/shell for the Wails side.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"clarae/apps/desktop/internal/app"
	"clarae/apps/desktop/internal/platform"
	"clarae/apps/desktop/internal/rpc"
	"clarae/apps/desktop/internal/shell"
	"clarae/apps/desktop/internal/telemetry"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is set at build time via -ldflags "-X main.Version=...".
var Version = "dev"

// appName is the name of the application: window title, menu and About box.
const appName = "Clarae notanda"

func main() {
	os.Exit(run())
}

func run() int {
	dataDirFlag := flag.String("data-dir", "", "application data directory (default $CLARAE_DATA_DIR or the OS config dir)")
	logLevel := flag.String("log-level", "info", "log level: debug|info|warn|error")
	flag.Parse()

	// A released binary carries none of the tags that open the application to the outside (an MCP
	// server on a local port, a server mode, the web inspector). The tag "production" is ours to
	// pass to go build, so it also tells a release from a dev build.
	if bi, ok := debug.ReadBuildInfo(); ok {
		if found, production := shell.ForbiddenBuildTags(bi); production && len(found) > 0 {
			fmt.Fprintln(os.Stderr, "clarae: a production build must not carry the build tags", found)
			return 1
		}
	}

	if *dataDirFlag != "" {
		_ = os.Setenv(platform.DataDirEnv, *dataDirFlag)
	}
	dataDir, err := platform.DataDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "clarae: data dir:", err)
		return 1
	}
	logger, closer, err := telemetry.NewLogger(dataDir, *logLevel, Version == "dev")
	if err != nil {
		fmt.Fprintln(os.Stderr, "clarae: logger:", err)
		return 1
	}
	defer func() { _ = closer.Close() }()
	telemetry.RouteSlog(logger)

	distFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		logger.Error().Err(err).Msg("frontend assets")
		return 1
	}

	// The shell is the Wails side of the application: the host the core talks to, the guard that
	// holds the window open until the frontend has flushed its notes, and the lifecycle that starts
	// and stops the core. They are built before the Wails application, which needs the services of
	// the core (the guard's ShouldQuit is one of its options), and are given the application below.
	var lc *shell.Lifecycle
	guard, guardWindow := shell.NewWailsCloseGuard(func() { lc.ArmWatchdog() })
	host := shell.NewHost()
	a := app.New(app.Options{DataDir: dataDir, Logger: logger, Version: Version, Host: host})
	lc = shell.NewLifecycle(a, guard)

	dispatcher := rpc.New()
	for _, s := range a.Services() {
		if err := dispatcher.Register(s); err != nil {
			logger.Error().Err(err).Msg("register service")
			return 1
		}
	}

	// A clarae:// URL on our own command line (first instance launched by the OS).
	if u, ok := platform.FindSchemeURL(os.Args[1:]); ok {
		a.HandleURL(u)
	}

	// The arguments of the calls larger than the transport of Wails takes (B-W4b) come in chunks to
	// a path of the asset server, behind the same middleware that sets the CSP.
	uploads := shell.NewUploadStore()

	wa := application.New(application.Options{
		Name:        appName,
		Description: "Local-first notes and knowledge base\nVersion " + Version,
		// Wails logs at debug level the arguments and the result of every binding call, passphrases
		// included: its logger has a floor at Warn, whatever --log-level says (E4).
		Logger:   telemetry.UIRuntimeLogger(logger),
		Services: []application.Service{application.NewService(NewCoreBridge(dispatcher, lc, uploads))},
		Assets: application.AssetOptions{
			Handler:        application.BundledAssetFileServer(distFS),
			Middleware:     assetMiddleware(uploads),
			DisableLogging: true, // the asset server logs every request
		},
		ShouldQuit:     guard.ShouldQuit,
		OnShutdown:     lc.Stop,
		SingleInstance: singleInstanceOptions(dataDir, a.OnSecondInstance),
		Mac:            application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		Linux:          application.LinuxOptions{ProgramName: "clarae"}, // the icon in the dock (StartupWMClass)
	})
	guardWindow.Bind(wa)

	win := wa.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            appName,
		Width:            1280,
		Height:           820,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: application.NewRGB(30, 30, 30),
		// The drag and drop of files uses the DOM (the editor and Excalidraw read dataTransfer): the
		// native file drop would take the drag from the web view.
		EnableFileDrop:             false,
		DefaultContextMenuDisabled: true,
		Mac:                        application.MacWindow{TitleBar: application.MacTitleBarHiddenInset},
	})
	host.Attach(wa, win)
	// The window close button (on macOS the only gesture that reaches the guard through the window:
	// wails#6570) and Cmd+Q, Alt+F4 and Quit (ShouldQuit) all go through the one guard.
	win.RegisterHook(events.Common.WindowClosing, guard.WindowClosing)

	// ServiceStartup runs before the loop of the platform: a failure of the core to start is shown
	// when the loop does.
	wa.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) { host.Started() })
	shell.ListenForURLs(wa, runtime.GOOS, a.HandleURL)
	shell.SetMenu(wa, runtime.GOOS, appName)

	err = wa.Run()
	lc.Stop() // idempotent: Run can return without OnShutdown having run (wails#6368)
	if err != nil {
		logger.Error().Err(err).Msg("wails run")
		return 1
	}
	return 0
}

// singleInstanceOptions is the single-instance lock of a data directory: two instances with
// different data directories coexist (two devices on one machine), a second one with the same
// directory hands its command line to the first and exits. The id is a valid D-Bus name on Linux
// (platform.InstanceID) and the messages between the instances are encrypted with a key derived
// from it. onSecond receives the whole os.Args of the second instance, program name included
// (FindSchemeURL finds the clarae:// URL among them: that is how Windows and Linux deliver it).
func singleInstanceOptions(dataDir string, onSecond func(args []string)) *application.SingleInstanceOptions {
	id := platform.InstanceID(dataDir)
	return &application.SingleInstanceOptions{
		UniqueID:      id,
		EncryptionKey: platform.InstanceKey(id),
		OnSecondInstanceLaunch: func(d application.SecondInstanceData) {
			onSecond(d.Args)
		},
	}
}

// assetMiddleware is what the asset server runs on every request: the CSP on the responses, in front
// of the chunks of the uploads (they are answered, not served, and carry the headers all the same).
func assetMiddleware(uploads *shell.UploadStore) func(http.Handler) http.Handler {
	chunks := uploads.Middleware()
	return func(next http.Handler) http.Handler { return cspMiddleware(chunks(next)) }
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
