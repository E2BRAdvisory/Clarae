package transport

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"runtime"
	"strings"
)

// ErrInsecureURL is returned for a server or identity provider URL that would
// carry tokens or vault content in clear: http to a host that is not this
// computer, or another scheme.
var ErrInsecureURL = errors.New("insecure url: use https (plain http is accepted only for localhost)")

// requireSecureURLs makes New refuse an insecure server URL. The browser core
// is exempt: it talks to the origin of the page that hosts it, which the
// browser already reached over the same scheme.
var requireSecureURLs = runtime.GOOS != "js"

// CheckSecureURL accepts an https URL, and an http one whose host is a
// loopback address (127.0.0.0/8, ::1) or "localhost", for development. A URL
// with user information is refused: it is never needed here, and it is the
// usual disguise of a host ("http://localhost@example.com" goes to
// example.com).
func CheckSecureURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid url %q", raw)
	}
	if u.User != nil {
		return fmt.Errorf("%w: %q carries user information", ErrInsecureURL, u.Redacted())
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
	}
	return fmt.Errorf("%w: %q", ErrInsecureURL, u.Redacted())
}

// isLoopbackHost reports whether host (without port or brackets) names this
// computer: "localhost" or a loopback IP literal. Other names are not
// resolved: what they resolve to is up to the network.
func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
