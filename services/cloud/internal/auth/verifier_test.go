package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"memobrain/services/cloud/internal/auth/authtest"
)

func TestVerifier(t *testing.T) {
	iss := authtest.New(t)
	ctx := context.Background()
	v, err := NewVerifier(ctx, iss.URL(), "memobrain-api", []string{"memobrain-desktop", "memobrain-web"})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("valid token", func(t *testing.T) {
		raw := iss.Token(t, authtest.TokenOptions{Username: "ada", Name: "Ada Admin", Roles: []string{"memobrain-admin", "memobrain-user"}})
		c, err := v.Verify(ctx, raw)
		if err != nil {
			t.Fatal(err)
		}
		if c.PreferredUsername != "ada" || c.Name != "Ada Admin" || c.AuthorizedParty != "memobrain-desktop" {
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

	_ = time.Second
}
