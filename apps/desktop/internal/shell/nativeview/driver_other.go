//go:build !js && !(darwin && cgo) && !windows

package nativeview

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/webview"
)

// Supported is false: this build has no driver.
const Supported = false

// New returns nil: no native web views on this system. The core then answers "unavailable" to every
// call of WebViewAPI, and the UI opens the page of an application in the system browser.
func New(*application.WebviewWindow) webview.Driver { return nil }
