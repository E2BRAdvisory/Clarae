package app

import (
	"context"
	"errors"
	"os"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"nodus/apps/desktop/internal/updater"
)

// EventUpdaterStatus carries an updater.Status to the frontend.
const EventUpdaterStatus = "updater:status"

// updaterService lazily builds the updater (it needs the data directory only).
func (a *App) updaterService() (*updater.Service, error) {
	a.updaterMu.Lock()
	defer a.updaterMu.Unlock()
	if a.updater != nil {
		return a.updater, nil
	}
	reason := ""
	if os.Getenv("NODUS_UPDATES") == "off" { // enterprise switch (managed images, offline sites)
		reason = "updates are disabled by the administrator"
	}
	svc, err := updater.New(updater.Options{
		DataDir:        a.opts.DataDir,
		CurrentVersion: a.opts.Version,
		DisabledReason: reason,
		OnStatus:       func(st updater.Status) { a.emit(EventUpdaterStatus, st) },
	})
	if err != nil {
		return nil, err
	}
	a.updater = svc
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
		runtime.Quit(u.app.ctx)
	}
	return res, nil
}

func (a *App) ctxOrBackground() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}
