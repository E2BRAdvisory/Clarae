//go:build !js

package app

// The update channel of the desktop. The browser build has none (bindings_updater_js.go): the
// cloud serves the web application, and the updater stays out of the WebAssembly core.

import (
	"context"
	"errors"
	"os"
	"sync"

	"memobrain/apps/desktop/internal/events"
	"memobrain/apps/desktop/internal/updater"
)

// EventUpdaterStatus carries an updater.Status to the frontend (desktop only: the browser build has
// no updater, so the event and its registry entry exist only in the native build).
var EventUpdaterStatus = events.New[updater.Status]("updater:status",
	"Desktop: the state of the application update changed (check, download, ready to install).")

// updaterState is the updater of the app, built on first use.
type updaterState struct {
	mu  sync.Mutex
	svc *updater.Service
}

// updaterService lazily builds the updater (it needs the data directory only).
func (a *App) updaterService() (*updater.Service, error) {
	a.updates.mu.Lock()
	defer a.updates.mu.Unlock()
	if a.updates.svc != nil {
		return a.updates.svc, nil
	}
	reason := ""
	if os.Getenv("MEMOBRAIN_UPDATES") == "off" { // enterprise switch (managed images, offline sites)
		reason = "updates are disabled by the administrator"
	}
	svc, err := updater.New(updater.Options{
		DataDir:        a.opts.DataDir,
		CurrentVersion: a.opts.Version,
		DisabledReason: reason,
		OnStatus:       func(st updater.Status) { EventUpdaterStatus.Send(a.emit, st) },
	})
	if err != nil {
		return nil, err
	}
	a.updates.svc = svc
	return svc, nil
}

// startUpdater runs the automatic checks for the lifetime of the app.
func (a *App) startUpdater(ctx context.Context) {
	svc, err := a.updaterService()
	if err != nil {
		a.logger.Warn().Err(err).Msg("updater unavailable")
		return
	}
	go svc.Run(ctx)
}

// UpdaterAPI exposes the update channel (§ distribution, M7-WP3).
type UpdaterAPI struct{ app *App }

// NewUpdaterAPI binds the API.
func NewUpdaterAPI(a *App) *UpdaterAPI { return &UpdaterAPI{app: a} }

// GetSettings returns the update preferences.
func (u *UpdaterAPI) GetSettings() (updater.Settings, error) {
	svc, err := u.app.updaterService()
	if err != nil {
		return updater.Settings{}, err
	}
	return svc.Settings(), nil
}

// SetSettings persists the preferences (channel, automatic checks).
func (u *UpdaterAPI) SetSettings(s updater.Settings) error {
	svc, err := u.app.updaterService()
	if err != nil {
		return err
	}
	return svc.SetSettings(s)
}

// Status returns the last known status.
func (u *UpdaterAPI) Status() (updater.Status, error) {
	svc, err := u.app.updaterService()
	if err != nil {
		return updater.Status{}, err
	}
	return svc.Status(), nil
}

// Check fetches the signed manifest now (the "Check for updates" command).
func (u *UpdaterAPI) Check() (updater.Status, error) {
	svc, err := u.app.updaterService()
	if err != nil {
		return updater.Status{}, err
	}
	return svc.Check(u.app.ctxOrBackground())
}

// Skip hides the notification for a version.
func (u *UpdaterAPI) Skip(version string) error {
	svc, err := u.app.updaterService()
	if err != nil {
		return err
	}
	return svc.Skip(version)
}

// Install downloads, verifies and applies the update; when the platform needs
// the app gone first, the application quits.
func (u *UpdaterAPI) Install() (updater.Result, error) {
	svc, err := u.app.updaterService()
	if err != nil {
		return updater.Result{}, err
	}
	res, err := svc.Install(u.app.ctxOrBackground())
	if err != nil {
		return res, err
	}
	if res.Quit {
		if u.app.ctx == nil {
			return res, errors.New("application not ready")
		}
		u.app.host.Quit(u.app.ctx)
	}
	return res, nil
}

func (a *App) ctxOrBackground() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}
