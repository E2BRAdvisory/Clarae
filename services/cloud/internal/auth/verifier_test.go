package auth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"clarae/services/cloud/internal/auth/authtest"
)

func TestVerifier(t *testing.T) {
	iss := authtest.New(t)
	ctx := context.Background()
	v, err := NewVerifier(ctx, iss.URL(), "clarae-api", []string{"clarae-desktop", "clarae-web"})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("valid token", func(t *testing.T) {
		raw := iss.Token(t, authtest.TokenOptions{Username: "ada", Name: "Ada Admin", Roles: []string{"clarae-admin", "clarae-user"}})
		c, err := v.Verify(ctx, raw)
		if err != nil {
			t.Fatal(err)
		}
		if c.PreferredUsername != "ada" || c.Name != "Ada Admin" || c.AuthorizedParty != "clarae-desktop" {
			t.Fatalf("unexpected claims %+v", c)
		}
		if RoleFromRealmRoles(c.RealmRoles) != RoleAdmin {
			t.Fatal("expected admin role")
		}
	})

	t.Run("expired beyond skew", func(t *testing.T) {
		raw := iss.Token(t, authtest.TokenOptions{ExpiresIn: -2 * ClockSkew})
		if _, err := v.Verify(ctx, raw); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})

	t.Run("expired within skew", func(t *testing.T) {
		raw := iss.Token(t, authtest.TokenOptions{ExpiresIn: -ClockSkew / 2})
		if _, err := v.Verify(ctx, raw); err != nil {
			t.Fatalf("token inside the skew window must be accepted: %v", err)
		}
	})

	t.Run("wrong audience", func(t *testing.T) {
		raw := iss.Token(t, authtest.TokenOptions{Audience: []string{"other-api"}})
		if _, err := v.Verify(ctx, raw); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})

	t.Run("wrong azp", func(t *testing.T) {
		raw := iss.Token(t, authtest.TokenOptions{AZP: "evil-client"})
		if _, err := v.Verify(ctx, raw); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})

	t.Run("wrong issuer", func(t *testing.T) {
		raw := iss.Token(t, authtest.TokenOptions{Issuer: "https://other.example"})
		if _, err := v.Verify(ctx, raw); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})

	t.Run("garbage", func(t *testing.T) {
		if _, err := v.Verify(ctx, "not.a.jwt"); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})

	t.Run("issued at is exposed", func(t *testing.T) {
		at := time.Now().Add(-time.Minute).Truncate(time.Second)
		c, err := v.Verify(ctx, iss.Token(t, authtest.TokenOptions{IssuedAt: at}))
		if err != nil || !c.IssuedAt.Equal(at) {
			t.Fatalf("iat %v (%v), want %v", c.IssuedAt, err, at)
		}
	})

	t.Run("signed by another key", func(t *testing.T) {
		// Same issuer URL and claims, but a key the JWKS does not hold.
		other := authtest.New(t)
		raw := other.Token(t, authtest.TokenOptions{Issuer: iss.URL()})
		if _, err := v.Verify(ctx, raw); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})

	t.Run("alg none", func(t *testing.T) {
		claims := fmt.Sprintf(`{"iss":%q,"sub":"x","aud":"clarae-api","exp":%d,"azp":"clarae-desktop"}`, iss.URL(), time.Now().Add(time.Hour).Unix())
		raw := b64(`{"alg":"none","typ":"JWT"}`) + "." + b64(claims) + "."
		if _, err := v.Verify(ctx, raw); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})

	t.Run("HS256 with a shared secret", func(t *testing.T) {
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.HS256, Key: []byte("0123456789abcdef0123456789abcdef")},
			(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "test-key"))
		if err != nil {
			t.Fatal(err)
		}
		raw, err := jwt.Signed(signer).Claims(jwt.Claims{
			Issuer: iss.URL(), Subject: "x", Audience: jwt.Audience{"clarae-api"},
			Expiry: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		}).Claims(map[string]any{"azp": "clarae-desktop"}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := v.Verify(ctx, raw); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("expected ErrInvalidToken, got %v", err)
		}
	})
}

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
