package transport

import (
	"net/url"
	"strings"
)

// Ref addresses a vault for the client methods that take a vault id: either the
// plain id (the caller owns the vault) or "<id>|share:<share id>" to work through
// a share (§3.4.7). Every method splits it back and adds the `scope` query
// parameter, so engines stay unaware of whether their vault is a mount.
func Ref(vault, scope string) string {
	if scope == "" {
		return vault
	}
	return vault + "|" + scope
}

func splitRef(ref string) (vault, scope string) {
	vault, scope, _ = strings.Cut(ref, "|")
	return vault, scope
}

// withScope appends the scope parameter to a request path.
func withScope(path, scope string) string {
	if scope == "" {
		return path
	}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + "scope=" + url.QueryEscape(scope)
}
