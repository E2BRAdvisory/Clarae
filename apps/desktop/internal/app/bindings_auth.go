package app

import (
	"context"
	"errors"
	"strings"

	"nodus/apps/desktop/internal/auth"
)

// AuthAPI exposes the cloud session to the frontend (§2.5 "auth").
type AuthAPI struct{ app *App }

// NewAuthAPI binds the API.
func NewAuthAPI(a *App) *AuthAPI { return &AuthAPI{app: a} }

// Status returns the current session state (also pushed as auth:state events).
func (x *AuthAPI) Status() auth.State { return x.app.auth.State() }

// Login runs the browser sign-in against serverURL and returns when it
// completes (progress is reported through auth:state events).
func (x *AuthAPI) Login(serverURL string) (auth.State, error) {
	serverURL = strings.TrimSpace(serverURL)
	if serverURL == "" {
		return x.app.auth.State(), errors.New("server url is required")
	}
	if !strings.HasPrefix(serverURL, "http://") && !strings.HasPrefix(serverURL, "https://") {
		serverURL = "https://" + serverURL
	}
	err := x.app.auth.Login(context.Background(), serverURL)
	return x.app.auth.State(), err
}

// Logout signs out and forgets the session.
func (x *AuthAPI) Logout() (auth.State, error) {
	err := x.app.auth.Logout(context.Background())
	return x.app.auth.State(), err
}
