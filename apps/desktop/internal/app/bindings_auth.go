package app

import (
	"context"
	"errors"
	"strings"

	"memobrain/apps/desktop/internal/auth"
	"memobrain/apps/desktop/internal/sync/transport"
)

// AuthAPI exposes the cloud session to the frontend (§2.5 "auth").
type AuthAPI struct{ app *App }

// NewAuthAPI binds the API.
func NewAuthAPI(a *App) *AuthAPI { return &AuthAPI{app: a} }

// Status returns the current session state (also pushed as auth:state events).
func (x *AuthAPI) Status() auth.State { return x.app.auth.State() }

// ErrCodeInsecureURL is the code of a sign-in refused because the server or
// its identity provider would be reached over plain http on another computer:
// tokens and vault content would travel in clear.
const ErrCodeInsecureURL = "insecure-url"

// Login runs the browser sign-in against serverURL and returns when it
// completes (progress is reported through auth:state events). A URL without
// scheme means https; http is accepted for this computer only (development,
// auth.Service.Login).
func (x *AuthAPI) Login(serverURL string) (auth.State, error) {
	serverURL = strings.TrimSpace(serverURL)
	if serverURL == "" {
		return x.app.auth.State(), errors.New("server url is required")
	}
	if !hasScheme(serverURL, "http://") && !hasScheme(serverURL, "https://") {
		serverURL = "https://" + serverURL
	}
	err := x.app.auth.Login(context.Background(), serverURL)
	return x.app.auth.State(), loginError(err)
}

func hasScheme(u, scheme string) bool {
	return len(u) >= len(scheme) && strings.EqualFold(u[:len(scheme)], scheme)
}

// loginError gives a refused insecure URL (the server's, or the identity
// provider's it announces) its code; other errors pass unchanged.
func loginError(err error) error {
	if errors.Is(err, transport.ErrInsecureURL) {
		return coded(ErrCodeInsecureURL, err.Error(), err)
	}
	return err
}

// Logout signs out and forgets the session.
func (x *AuthAPI) Logout() (auth.State, error) {
	err := x.app.auth.Logout(context.Background())
	return x.app.auth.State(), err
}

// ReregisterDevice replaces a device the cloud refuses as revoked with a new registration of the
// same account, then synchronization resumes and sends what waited meanwhile (nothing local is
// lost). When the account itself is no longer signed in, the state becomes signed_out and Login
// signs in again, which registers a new device as well.
func (x *AuthAPI) ReregisterDevice() (auth.State, error) {
	err := x.app.auth.ReregisterDevice(context.Background())
	return x.app.auth.State(), bindingError(err)
}
