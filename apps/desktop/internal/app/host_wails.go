//go:build !js

package app

import (
	"context"

	"github.com/Bios-Marcel/wastebasket/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"memobrain/apps/desktop/internal/platform"
)

// isWeb tells the browser build from the desktop one.
const isWeb = false

// defaultHost is the Wails window.
func defaultHost() Host { return wailsHost{} }

// systemTrash moves a file or folder (absolute path) to the OS trash.
func systemTrash(path string) error { return wastebasket.Trash(path) }

// wailsHost implements Host on the desktop with the Wails runtime: events, native dialogs, the
// system browser, printing and quitting the window. Its twin for the browser is webHost
// (host_web.go, built with GOOS=js).
//
// Every Host method is implemented by both hosts and classified by capability in
// HostMethodCapability (host.go): "" when every host supports it, otherwise the capability
// that is false where it fails. TestHostCapabilities fails on a method left unclassified, and in
// `task test-wasm` capabilities_web_test.go calls every webHost method and fails when one that
// errors is not gated by a false capability. See docs/desktop-web-sync.md, "Il confine nel core Go".
type wailsHost struct{}

func (wailsHost) Emit(ctx context.Context, name string, payload any) {
	runtime.EventsEmit(ctx, name, payload)
}

func (wailsHost) SaveFile(ctx context.Context, d SaveDialog) (string, error) {
	return runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{
		Title:           d.Title,
		DefaultFilename: d.DefaultFilename,
		Filters:         wailsFilters(d.Filters),
	})
}

func (wailsHost) Delivered(context.Context, string) {}

func (wailsHost) OpenFile(ctx context.Context, d OpenDialog) (string, error) {
	return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{
		Title: d.Title, CanCreateDirectories: d.CanCreateDirectories, Filters: wailsFilters(d.Filters),
	})
}

func (wailsHost) OpenDirectory(ctx context.Context, d OpenDialog) (string, error) {
	return runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{Title: d.Title, CanCreateDirectories: d.CanCreateDirectories})
}

func (wailsHost) OpenURL(ctx context.Context, url string) { runtime.BrowserOpenURL(ctx, url) }
func (wailsHost) Print(ctx context.Context)               { runtime.WindowPrint(ctx) }
func (wailsHost) Quit(ctx context.Context)                { runtime.Quit(ctx) }

func (wailsHost) ShowWindow(ctx context.Context) {
	runtime.WindowUnminimise(ctx)
	runtime.Show(ctx)
}

func (wailsHost) ErrorDialog(ctx context.Context, title, message string) {
	_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{Type: runtime.ErrorDialog, Title: title, Message: message})
}

func wailsFilters(in []FileFilter) []runtime.FileFilter {
	out := make([]runtime.FileFilter, len(in))
	for i, f := range in {
		out[i] = runtime.FileFilter{DisplayName: f.DisplayName, Pattern: f.Pattern}
	}
	return out
}

// OnSecondInstance is the Wails single-instance callback: another instance
// was launched with these arguments (Windows/Linux deliver memobrain:// URLs
// this way). The running window is brought to the front.
func (a *App) OnSecondInstance(data options.SecondInstanceData) {
	a.logger.Info().Strs("args", redactArgs(data.Args)).Msg("second instance launch")
	if a.ctx != nil {
		a.host.ShowWindow(a.ctx)
	}
	if u, ok := platform.FindSchemeURL(data.Args); ok {
		a.HandleURL(u)
	}
}
