//go:build !js

package app

import (
	"context"
	"errors"

	"github.com/Bios-Marcel/wastebasket/v2"
)

// isWeb tells the browser build from the desktop one.
const isWeb = false

// defaultHost is what New uses when Options.Host is nil: a host with no window, for tests and tools
// that build the App without a shell. The desktop shell (internal/shell) passes its own host.
func defaultHost() Host { return headlessHost{} }

// systemTrash moves a file or folder (absolute path) to the OS trash.
func systemTrash(path string) error { return wastebasket.Trash(path) }

var errNoWindow = errors.New("no window: the application runs without a host")

// headlessHost is the host of an App that has no window: events go nowhere, dialogs are cancelled
// and what needs the system fails. It keeps Wails out of this package, which also builds for the
// browser.
type headlessHost struct{}

func (headlessHost) Emit(context.Context, string, any) {}
func (headlessHost) SaveFile(context.Context, SaveDialog) (string, error) {
	return "", errNoWindow
}
func (headlessHost) Delivered(context.Context, string) {}
func (headlessHost) OpenFile(context.Context, OpenDialog) (string, error) {
	return "", errNoWindow
}
func (headlessHost) OpenDirectory(context.Context, OpenDialog) (string, error) {
	return "", errNoWindow
}
func (headlessHost) OpenURL(context.Context, string)             {}
func (headlessHost) Print(context.Context)                       {}
func (headlessHost) OpenPath(context.Context, string) error      { return errNoWindow }
func (headlessHost) RevealPath(context.Context, string) error    { return errNoWindow }
func (headlessHost) ShowWindow(context.Context)                  {}
func (headlessHost) Quit(context.Context)                        {}
func (headlessHost) ErrorDialog(context.Context, string, string) {}
