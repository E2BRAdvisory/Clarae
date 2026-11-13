//go:build !js

package shell

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// ShowStartupError tells the user why the application does not start, and returns when the dialog
// is dismissed. It is for what happens before the application of the product exists (the data
// directory cannot be taken over): a bare Wails application with no window and no services whose
// only task is the dialog; the dialogs of Host wait for the application of the product, which
// would not run. It must be the only application of the process: call it instead of building the
// real one, and exit.
func ShowStartupError(name, title, message string) {
	a := application.New(application.Options{Name: name})
	a.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go func() {
			a.Dialog.Error().SetTitle(title).SetMessage(message).Show()
			a.Quit()
		}()
	})
	_ = a.Run()
}
