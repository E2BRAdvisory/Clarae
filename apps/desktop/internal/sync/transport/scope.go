package transport

import (
	"strings"

	"github.com/google/uuid"
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

// vaultRef parses a Ref into the vault id and the optional scope parameter.
func vaultRef(ref string) (uuid.UUID, *string, error) {
	vault, scope := splitRef(ref)
	id, err := parseID("vault", vault)
	if err != nil {
		return uuid.UUID{}, nil, err
	}
	return id, ptrIf(scope), nil
}
