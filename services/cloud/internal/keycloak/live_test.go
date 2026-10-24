package keycloak

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestLiveKeycloak runs the client against a real Keycloak (make stack-up) to check the REST
// contract the fakes only imitate. It is skipped unless KC_LIVE_URL is set:
//
//	KC_LIVE_URL=http://localhost:8080 go test ./internal/keycloak -run Live -v
func TestLiveKeycloak(t *testing.T) {
	base := os.Getenv("KC_LIVE_URL")
	if base == "" {
		t.Skip("KC_LIVE_URL not set")
	}
	secret := os.Getenv("KC_LIVE_SECRET")
	if secret == "" {
		secret = "dev-admin-svc-secret"
	}
	kc := New(Config{BaseURL: base, Realm: "nodus", ClientID: "nodus-admin-svc", ClientSecret: secret})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	name := "live-" + uuid.NewString()[:8]
	sub, err := kc.CreateUser(ctx, UserSpec{Username: name, Email: name + "@nodus.test", FirstName: "Live", TemporaryPassword: "Temp-pass-123", Admin: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _ = kc.SetEnabled(context.Background(), sub, false) })
	if _, err := kc.CreateUser(ctx, UserSpec{Username: name, Email: "other-" + name + "@nodus.test"}); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate username: %v", err)
	}
	if err := kc.UpdateUser(ctx, sub, "renamed-"+name+"@nodus.test", "Renamed"); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := kc.SetAdmin(ctx, sub, false); err != nil {
		t.Fatalf("revoke admin: %v", err)
	}
	if err := kc.SetAdmin(ctx, sub, true); err != nil {
		t.Fatalf("grant admin: %v", err)
	}
	if err := kc.SetEnabled(ctx, sub, false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if err := kc.SetEnabled(ctx, sub, true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if _, err := kc.Sessions(ctx, sub); err != nil {
		t.Fatalf("sessions: %v", err)
	}
	// No SMTP in the dev realm: the reset is still required, only the mail is not sent.
	if _, err := kc.RequirePasswordReset(ctx, sub); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if _, err := kc.Sessions(ctx, uuid.NewString()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user: %v", err)
	}
}
