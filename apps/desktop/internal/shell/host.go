//go:build !js

// Package shell is the desktop shell around the core: the implementation of app.Host on the
// Wails runtime (events, native dialogs, system browser, printing, quitting) and the state machine
// that holds the window open until the frontend has flushed its notes (CloseGuard). It is the only
// package of the core that imports Wails (TestAppDoesNotImportWails); internal/app, which also
// builds to WebAssembly, depends on none of it. Its twin for the browser is app's webHost
// (host_web.go, GOOS=js).
package shell

import (
	"context"
	"errors"
	goruntime "runtime"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/app"
)

// Host implements app.Host on the desktop with the Wails v3 application and its window.
//
// Every app.Host method is implemented by both hosts and classified by capability in
// app.HostMethodCapability: "" when every host supports it, otherwise the capability that is false
// where it fails. TestHostCapabilities fails on a method left unclassified, and in `task test-wasm`
// capabilities_web_test.go calls every webHost method and fails when one that errors is not gated
// by a false capability. See docs/desktop-web-sync.md, "Il confine nel core Go".
//
// The host is built before the application (app.New wants it, application.New wants the services
// that app.New makes) and is given the application and the window with Attach. The context of the
// methods is ignored: v3 has no context to hand to its calls.
type Host struct {
	mu      sync.Mutex
	app     *application.App
	win     *application.WebviewWindow
	started bool     // ApplicationStarted has fired: the loop of the platform runs and dialogs can show
	waiting []dialog // error dialogs asked before that

	// showError displays an error dialog now (replaced in tests).
	showError func(title, message string)
}

type dialog struct{ title, message string }

var _ app.Host = (*Host)(nil)

// NewHost returns the Wails host.
func NewHost() *Host {
	h := &Host{}
	h.showError = h.showErrorNow
	return h
}

// Attach gives the host the application and its main window.
func (h *Host) Attach(a *application.App, win *application.WebviewWindow) {
	h.mu.Lock()
	h.app, h.win = a, win
	h.mu.Unlock()
}

// Started is called on ApplicationStarted: the error dialogs that the core asked for while it
// started (ServiceStartup runs before the loop of the platform, where a dialog would hang or be
// dropped) are shown now, in order.
func (h *Host) Started() {
	h.mu.Lock()
	h.started = true
	waiting := h.waiting
	h.waiting = nil
	h.mu.Unlock()
	for _, d := range waiting {
		h.showError(d.title, d.message)
	}
}

func (h *Host) application() (*application.App, *application.WebviewWindow) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.app, h.win
}

func (h *Host) Emit(_ context.Context, name string, payload any) {
	a, _ := h.application()
	if a == nil {
		return // before the application exists nobody listens
	}
	if payload == nil {
		a.Event.Emit(name)
		return
	}
	a.Event.Emit(name, payload)
}

func (h *Host) SaveFile(_ context.Context, d app.SaveDialog) (string, error) {
	a, win := h.application()
	if a == nil {
		return "", errNoApplication
	}
	opts := &application.SaveFileDialogOptions{
		Title:                d.Title,
		Filename:             d.DefaultFilename,
		CanCreateDirectories: true,
		Filters:              wailsFilters(d.Filters),
	}
	if win != nil {
		opts.Window = win
	}
	return dialogAnswer(a.Dialog.SaveFileWithOptions(opts).PromptForSingleSelection())
}

func (*Host) Delivered(context.Context, string) {}

func (h *Host) OpenFile(_ context.Context, d app.OpenDialog) (string, error) {
	return h.prompt(d, false)
}

func (h *Host) OpenDirectory(_ context.Context, d app.OpenDialog) (string, error) {
	return h.prompt(d, true)
}

func (h *Host) prompt(d app.OpenDialog, directory bool) (string, error) {
	a, win := h.application()
	if a == nil {
		return "", errNoApplication
	}
	opts := &application.OpenFileDialogOptions{
		Title:                d.Title,
		CanChooseFiles:       !directory,
		CanChooseDirectories: directory,
		CanCreateDirectories: d.CanCreateDirectories,
	}
	if !directory {
		opts.Filters = wailsFilters(d.Filters)
	}
	if win != nil {
		opts.Window = win
	}
	return dialogAnswer(a.Dialog.OpenFileWithOptions(opts).PromptForSingleSelection())
}

func (*Host) OpenPath(_ context.Context, path string) error {
	name, args := openCommand(goruntime.GOOS, path)
	return runLauncher(name, args...)
}

func (*Host) RevealPath(_ context.Context, path string) error {
	name, args := revealCommand(goruntime.GOOS, path)
	return runLauncher(name, args...)
}

func (h *Host) OpenURL(_ context.Context, url string) {
	if a, _ := h.application(); a != nil {
		_ = a.Browser.OpenURL(url)
	}
}

func (h *Host) Print(context.Context) {
	if _, win := h.application(); win != nil {
		_ = win.Print()
	}
}

// Quit asks the application to quit. It goes through the close guard like every other gesture
// (ShouldQuit): the first request while the frontend may hold unsaved notes is held, and the
// frontend's own Quit after it has flushed is the one that passes. The watchdog is armed by the
// guard when it lets a request through, not here: armed on a request that is then held, it would
// cut the flush the guard waits for.
func (h *Host) Quit(context.Context) {
	if a, _ := h.application(); a != nil {
		a.Quit()
	}
}

func (h *Host) ShowWindow(context.Context) {
	_, win := h.application()
	if win == nil {
		return
	}
	win.UnMinimise()
	win.Show()
	win.Focus()
}

// ErrorDialog shows the failure that stops the application. Asked before the platform loop runs
// (the core starts in ServiceStartup), it waits for Started.
func (h *Host) ErrorDialog(_ context.Context, title, message string) {
	h.mu.Lock()
	if !h.started {
		h.waiting = append(h.waiting, dialog{title, message})
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()
	h.showError(title, message)
}

func (h *Host) showErrorNow(title, message string) {
	if a, _ := h.application(); a != nil {
		a.Dialog.Error().SetTitle(title).SetMessage(message).Show()
	}
}

// dialogAnswer turns what a file dialog of the toolkit answers into what app.Host promises: the
// empty path and no error when the user cancels. macOS and Linux close the channel of the dialog
// and answer "" already; on Windows v3 returns the "cancelled by user" error of its
// go-common-file-dialog (v2 filtered it out), which would reach the UI as a failed export or import.
func dialogAnswer(path string, err error) (string, error) {
	if isDialogCancelled(err) {
		return "", nil
	}
	return path, err
}

// cancelledByUser is the text of cfd.ErrorCancelled of Wails v3 (internal/go-common-file-dialog):
// the package is internal and the error is wrapped on its way up, so it is recognized by its text.
const cancelledByUser = "cancelled by user"

func isDialogCancelled(err error) bool {
	return err != nil && strings.Contains(err.Error(), cancelledByUser)
}

// errNoApplication is what a dialog asked before the application exists answers.
var errNoApplication = errors.New("the application is not running yet")

func wailsFilters(in []app.FileFilter) []application.FileFilter {
	out := make([]application.FileFilter, len(in))
	for i, f := range in {
		out[i] = application.FileFilter{DisplayName: f.DisplayName, Pattern: f.Pattern}
	}
	return out
}
