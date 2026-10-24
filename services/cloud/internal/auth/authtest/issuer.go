// Package authtest provides an in-process OIDC issuer for tests: discovery
// document, JWKS and RS256-signed access tokens shaped like Keycloak's.
package authtest

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// Issuer is a fake identity provider.
type Issuer struct {
	Server *httptest.Server
	key    *rsa.PrivateKey
	signer jose.Signer
}

// TokenOptions shape a token; zero values are sensible defaults.
type TokenOptions struct {
	Subject   string
	Username  string
	Email     string
	Name      string
	AZP       string
	Audience  []string
	Roles     []string
	ExpiresIn time.Duration
	// Issuer overrides the iss claim (to test rejection).
	Issuer string
}

// New starts the issuer; it is closed when the test ends.
func New(t *testing.T) *Issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "test-key"))
	if err != nil {
		t.Fatal(err)
	}
	iss := &Issuer{key: key, signer: signer}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                iss.Server.URL,
			"jwks_uri":                              iss.Server.URL + "/jwks",
			"authorization_endpoint":                iss.Server.URL + "/auth",
			"token_endpoint":                        iss.Server.URL + "/token",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
			Key: &key.PublicKey, KeyID: "test-key", Algorithm: "RS256", Use: "sig",
		}}})
	})
	iss.Server = httptest.NewServer(mux)
	t.Cleanup(iss.Server.Close)
	return iss
}

// URL is the issuer identifier.
func (i *Issuer) URL() string { return i.Server.URL }

// Token signs an access token.
func (i *Issuer) Token(t *testing.T, o TokenOptions) string {
	t.Helper()
	if o.Subject == "" {
		o.Subject = "00000000-0000-4000-8000-000000000001"
	}
	if o.Username == "" {
		o.Username = "user1"
	}
	if o.Email == "" {
		o.Email = o.Username + "@nodus.local"
	}
	if o.AZP == "" {
		o.AZP = "nodus-desktop"
	}
	if len(o.Audience) == 0 {
		o.Audience = []string{"nodus-api"}
	}
	if len(o.Roles) == 0 {
		o.Roles = []string{"nodus-user"}
	}
	if o.ExpiresIn == 0 {
		o.ExpiresIn = 5 * time.Minute
	}
	issuer := o.Issuer
	if issuer == "" {
		issuer = i.Server.URL
	}
	now := time.Now()
	claims := jwt.Claims{
		Issuer:    issuer,
		Subject:   o.Subject,
		Audience:  jwt.Audience(o.Audience),
		IssuedAt:  jwt.NewNumericDate(now),
		Expiry:    jwt.NewNumericDate(now.Add(o.ExpiresIn)),
		NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)),
	}
	private := map[string]any{
		"typ":                "Bearer",
		"azp":                o.AZP,
		"preferred_username": o.Username,
		"email":              o.Email,
		"name":               o.Name,
		"realm_access":       map[string]any{"roles": o.Roles},
	}
	raw, err := jwt.Signed(i.signer).Claims(claims).Claims(private).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
