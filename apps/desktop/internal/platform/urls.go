package platform

import (
	"errors"
	"net/url"
	"strings"
)

// Scheme is the custom URL scheme registered by the installers (§2.2.1, D-08).
const Scheme = "memobrain"

// URLKind distinguishes the supported memobrain:// URLs.
type URLKind string

// Supported URL kinds.
const (
	// URLOpen opens a vault and optionally a file: memobrain://open?vault=<name|path>&file=<rel path>
	URLOpen URLKind = "open"
	// URLAuthCallback is the OIDC redirect fallback: memobrain://auth/callback?code=…&state=…
	URLAuthCallback URLKind = "auth-callback"
	// URLAuthLogout is the post-logout redirect: memobrain://auth/logout
	URLAuthLogout URLKind = "auth-logout"
)

// SchemeURL is a parsed memobrain:// URL.
type SchemeURL struct {
	Kind   URLKind
	Params url.Values
}

// ErrNotSchemeURL is returned for anything that is not a memobrain:// URL.
var ErrNotSchemeURL = errors.New("not a memobrain:// url")

// ParseSchemeURL parses a memobrain:// URL delivered by the OS.
func ParseSchemeURL(raw string) (SchemeURL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return SchemeURL{}, err
	}
	if !strings.EqualFold(u.Scheme, Scheme) {
		return SchemeURL{}, ErrNotSchemeURL
	}
	path := strings.Trim(u.Host+"/"+strings.Trim(u.Path, "/"), "/")
	switch path {
	case "open":
		return SchemeURL{Kind: URLOpen, Params: u.Query()}, nil
	case "auth/callback":
		return SchemeURL{Kind: URLAuthCallback, Params: u.Query()}, nil
	case "auth/logout":
		return SchemeURL{Kind: URLAuthLogout, Params: u.Query()}, nil
	default:
		return SchemeURL{}, errors.New("unknown memobrain:// url: " + path)
	}
}

// FindSchemeURL returns the first memobrain:// URL among command line arguments
// (how Windows and Linux deliver the URL to a second instance).
func FindSchemeURL(args []string) (string, bool) {
	for _, a := range args {
		if strings.HasPrefix(strings.ToLower(a), Scheme+"://") {
			return a, true
		}
	}
	return "", false
}
