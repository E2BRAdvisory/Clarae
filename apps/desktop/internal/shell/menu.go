//go:build !js

package shell

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// ExplicitMenu is the menu of the application on macOS: App, Edit and Window, the items of the
// default menu of Wails v2 (WailsMenu.m appendRole), nothing else. Without a menu Cmd+C, Cmd+V,
// Cmd+Z and Cmd+Q do not reach the web view, and the default menu of v3 adds Reload, Zoom and a
// "Learn More" that navigates the window to wails.io: a reload that skips the flush of the notes
// and a remote page, against the offline, closed-architecture application (B-D7).
//
// The roles are assembled item by item: the v3 AppMenu role adds a "Services" submenu, and the v3
// WindowMenu role has "Bring All to Front" where v2 has the full-screen toggle.
func ExplicitMenu(appName string) *application.Menu {
	m := application.NewMenu()
	app := m.AddSubmenu(appName)
	app.AddRole(application.About)
	app.AddSeparator()
	app.AddRole(application.Hide)
	app.AddRole(application.HideOthers)
	app.AddRole(application.UnHide)
	app.AddSeparator()
	app.AddRole(application.Quit)
	edit := m.AddSubmenu("Edit")
	edit.AddRole(application.Undo)
	edit.AddRole(application.Redo)
	edit.AddSeparator()
	edit.AddRole(application.Cut)
	edit.AddRole(application.Copy)
	edit.AddRole(application.Paste)
	edit.AddRole(application.PasteAndMatchStyle)
	edit.AddRole(application.Delete)
	edit.AddRole(application.SelectAll)
	edit.AddSeparator()
	edit.AddRole(application.SpeechMenu)
	win := m.AddSubmenu("Window")
	win.AddRole(application.Minimise)
	win.AddRole(application.Zoom)
	win.AddSeparator()
	win.AddRole(application.ToggleFullscreen)
	return m
}

// SetMenu installs the application menu on macOS only. Elsewhere Menu.Set would do nothing (v3
// applies the application menu on darwin alone, application.go) or, on Linux, may add a bar that
// v2 never had: Windows and Linux have no menu bar.
func SetMenu(a *application.App, goos, appName string) bool {
	if goos != "darwin" {
		return false
	}
	a.Menu.Set(ExplicitMenu(appName))
	return true
}
