//go:build js

package app

// The browser build has no update channel: the cloud serves the web application, which is always
// up to date, and the workbench hides the updater there (capability "updater"). UpdaterAPI keeps
// its methods, so the bindings are the same on both hosts, but each one refuses; the updater
// package stays out of the WebAssembly core (ADR-0030).

import (
	"context"
	"errors"
)

// errNoUpdater answers every UpdaterAPI call in the browser.
var errNoUpdater = errors.New("the web application is always up to date: the cloud serves it")

// updaterState holds nothing in the browser.
type updaterState struct{}

// startUpdater has nothing to run in the browser.
func (a *App) startUpdater(context.Context) {}

// UpdaterAPI exposes the update channel (§ distribution, M7-WP3): not available in the browser.
type UpdaterAPI struct{ app *App }

// NewUpdaterAPI binds the API.
func NewUpdaterAPI(a *App) *UpdaterAPI { return &UpdaterAPI{app: a} }

// GetSettings is not available in the browser.
func (u *UpdaterAPI) GetSettings() (struct{}, error) { return struct{}{}, errNoUpdater }

// SetSettings is not available in the browser.
func (u *UpdaterAPI) SetSettings(struct{}) error { return errNoUpdater }

// Status is not available in the browser.
func (u *UpdaterAPI) Status() (struct{}, error) { return struct{}{}, errNoUpdater }

// Check is not available in the browser.
func (u *UpdaterAPI) Check() (struct{}, error) { return struct{}{}, errNoUpdater }

// Skip is not available in the browser.
func (u *UpdaterAPI) Skip(string) error { return errNoUpdater }

// Install is not available in the browser.
func (u *UpdaterAPI) Install() (struct{}, error) { return struct{}{}, errNoUpdater }
