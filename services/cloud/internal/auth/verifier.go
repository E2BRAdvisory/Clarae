// Package auth validates Keycloak bearer tokens (JWKS, iss, aud, exp, azp),
// provisions users just-in-time and exposes the caller as a Principal in the
// request context (Specifications.md §1.3, §3.3).
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// ErrInvalidToken wraps every verification failure.
var ErrInvalidToken = errors.New("invalid token")

// Claims are the token claims the service relies on.
type Claims struct {
	Subject           string
	PreferredUsername string
	Email             string
	Name              string
	AuthorizedParty   string
	RealmRoles        []string
	Expiry            time.Time
	// IssuedAt is the iat claim: provisioning trusts the realm roles of a
	// token only when it was issued after the last role change (ADR-0041).
	IssuedAt time.Time
}

// rawClaims mirrors the Keycloak access token layout.
type rawClaims struct {
	PreferredUsername string `json:"preferred_username"`
	Email             string `json:"email"`
	Name              string `json:"name"`
	AuthorizedParty   string `json:"azp"`
	RealmAccess       struct {
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

// Verifier validates access tokens against the issuer's JWKS.
type Verifier struct {
	verifier   *oidc.IDTokenVerifier
	allowedAZP []string
}

// ClockSkew is the tolerance applied to exp (§3.7: ≤ 60 s).
const ClockSkew = 60 * time.Second

// oidcHTTPTimeout bounds the discovery request and every JWKS fetch: without
// it a stalled identity provider would hold the key refresh, and with it every
// token signed by a new key, until the process restarts.
const oidcHTTPTimeout = 10 * time.Second

// signingAlgs are the token signature algorithms accepted.
var signingAlgs = []string{oidc.RS256, oidc.ES256, oidc.PS256}

// NewVerifier discovers the issuer and prepares the JWKS cache. It fails
// when the issuer is unreachable; callers retry at startup.
func NewVerifier(ctx context.Context, issuer, audience string, allowedAZP []string) (*Verifier, error) {
	client := &http.Client{Timeout: oidcHTTPTimeout}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, client), issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery %s: %w", issuer, err)
	}
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := provider.Claims(&doc); err != nil {
		return nil, fmt.Errorf("oidc discovery %s: %w", issuer, err)
	}
	if doc.JWKSURI == "" {
		return nil, fmt.Errorf("oidc discovery %s: no jwks_uri", issuer)
	}
	cfg := &oidc.Config{
		ClientID:             audience,
		SupportedSigningAlgs: signingAlgs,
		Now:                  func() time.Time { return time.Now().Add(-ClockSkew) },
	}
	// NewProvider checked that the document's issuer is the one configured.
	keys := newKeySet(doc.JWKSURI, client, signingAlgs)
	return &Verifier{verifier: oidc.NewVerifier(doc.Issuer, keys, cfg), allowedAZP: allowedAZP}, nil
}

// Verify checks signature, issuer, audience and expiry, then extracts claims
// and enforces the azp allow-list.
func (v *Verifier) Verify(ctx context.Context, rawToken string) (Claims, error) {
	tok, err := v.verifier.Verify(ctx, rawToken)
	if err != nil {
		return Claims{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	var rc rawClaims
	if err := tok.Claims(&rc); err != nil {
		return Claims{}, fmt.Errorf("%w: claims: %w", ErrInvalidToken, err)
	}
	if len(v.allowedAZP) > 0 && !slices.Contains(v.allowedAZP, rc.AuthorizedParty) {
		return Claims{}, fmt.Errorf("%w: azp %q not allowed", ErrInvalidToken, rc.AuthorizedParty)
	}
	if tok.Subject == "" {
		return Claims{}, fmt.Errorf("%w: missing sub", ErrInvalidToken)
	}
	return Claims{
		Subject:           tok.Subject,
		PreferredUsername: rc.PreferredUsername,
		Email:             rc.Email,
		Name:              rc.Name,
		AuthorizedParty:   rc.AuthorizedParty,
		RealmRoles:        rc.RealmAccess.Roles,
		Expiry:            tok.Expiry,
		IssuedAt:          tok.IssuedAt,
	}, nil
}
