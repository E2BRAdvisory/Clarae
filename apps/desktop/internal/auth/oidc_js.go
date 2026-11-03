//go:build js

package auth

// The browser build has no desktop sign-in (oidc_native.go): the page signs in with OIDC and hands
// the core its access tokens (Options.Hosted), so the OIDC and OAuth clients stay out of the
// WebAssembly core (ADR-0030).

import (
	"context"
	"errors"
)

// errDesktopSignIn answers the desktop sign-in, which is not available in the browser.
var errDesktopSignIn = errors.New("signing in through the system browser is not available in the browser")

// idpClient holds nothing: a session of the browser build never runs discovery.
type idpClient struct{}

func (s *Service) login(context.Context, string) error { return errDesktopSignIn }

func (s *Service) refreshToken(context.Context) (string, error) { return "", errDesktopSignIn }

func (s *Service) revokeRefresh(context.Context, *persisted, *idpClient, string) {}
