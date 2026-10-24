package auth

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Role is the global RBAC role (§3.3.2), mirrored from the realm roles.
type Role string

// Global roles.
const (
	RoleAdmin Role = "admin"
	RoleUser  Role = "user"
)

// Realm role names in Keycloak (§3.3.1).
const (
	RealmRoleAdmin = "nodus-admin"
	RealmRoleUser  = "nodus-user"
)

// RoleFromRealmRoles maps Keycloak realm roles to the application role.
func RoleFromRealmRoles(roles []string) Role {
	for _, r := range roles {
		if r == RealmRoleAdmin {
			return RoleAdmin
		}
	}
	return RoleUser
}

// Status is the account status stored in users.status.
type Status string

// Account statuses.
const (
	StatusPending   Status = "pending"
	StatusActive    Status = "active"
	StatusSuspended Status = "suspended"
	StatusDeleted   Status = "deleted"
)

// Principal is the authenticated caller.
type Principal struct {
	UserID   uuid.UUID
	Subject  string
	Username string
	Role     Role
	Status   Status
}

// IsAdmin reports whether the caller holds the admin role.
func (p Principal) IsAdmin() bool { return p.Role == RoleAdmin }

type principalKey struct{}

// WithPrincipal stores p in ctx.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the caller stored by the middleware; ok is false on
// unauthenticated routes.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

type expiryKey struct{}

// WithTokenExpiry stores the expiry of the access token that authenticated the request.
func WithTokenExpiry(ctx context.Context, t time.Time) context.Context {
	return context.WithValue(ctx, expiryKey{}, t)
}

// TokenExpiryFrom returns the token expiry, or the zero time when unknown.
func TokenExpiryFrom(ctx context.Context) time.Time {
	t, _ := ctx.Value(expiryKey{}).(time.Time)
	return t
}

// MustPrincipal returns the caller or panics: use only on routes that the
// OpenAPI contract marks as authenticated.
func MustPrincipal(ctx context.Context) Principal {
	p, ok := PrincipalFrom(ctx)
	if !ok {
		panic("auth: no principal in context on an authenticated route")
	}
	return p
}
