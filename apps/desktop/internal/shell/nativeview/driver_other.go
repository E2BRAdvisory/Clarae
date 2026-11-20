//go:build !js && !(darwin && cgo) && !windows && !(linux && cgo && gtk3 && !android && !server && !purego)

package nativeview

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/webview"
)

// Supported is false: this build has no driver (a build without cgo, Linux without the gtk3 tag or with
// purego, a system that is neither macOS, Windows nor Linux).
const Supported = false

// New returns nil: no native web views on this system. The core then answers "unavailable" to every
// call of WebViewAPI, and the UI opens the page of an application in the system browser.
func New(*application.WebviewWindow, string) webview.Driver { return nil }
