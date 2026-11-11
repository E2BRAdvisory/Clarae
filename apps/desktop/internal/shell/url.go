//go:build !js

package shell

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// ListenForURLs registers handle for the memobrain:// URLs the system hands to the running
// application, and reports whether it did. Only macOS delivers them as an event
// (ApplicationLaunchedWithUrl, an Apple Event: the URL is not in os.Args). On Windows and Linux the
// URL is on the command line: the first instance reads os.Args itself, a later one reaches the
// first through the single-instance callback. Listening for the event there too would deliver the
// same URL twice, because v3 emits it when the command line is exactly one URL
// (application_windows.go, application_linux_gtk3_shared.go).
func ListenForURLs(a *application.App, goos string, handle func(url string)) bool {
	if goos != "darwin" {
		return false
	}
	a.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(e *application.ApplicationEvent) {
		if url := e.Context().URL(); url != "" {
			handle(url)
		}
	})
	return true
}
