//go:build integration

package sync_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/vaultcrypto"
)

// attachEmpty attaches an empty local folder as vault localID.
func (e *managerEnv) attachEmpty(t *testing.T, localID string) {
	t.Helper()
	dir := filepath.Join(e.root, localID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.Attach(context.Background(), localID, fs); err != nil {
		t.Fatal(err)
	}
}

func envelopeVersions(t *testing.T, c *transport.Client, cloudID string) map[string]int {
	t.Helper()
	envs, err := c.GetKeyEnvelopes(context.Background(), cloudID)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]int{}
	for _, e := range envs {
		out[string(e.Kind)] = vaultcrypto.EnvelopeVersion(e.WrappedVmk)
	}
	return out
}

// ADR-0034 release N+1: a vault created with the default configuration has
// v2 envelopes right away (uploaded just after the creation, which assigns the
// vault id).
func TestPrivateVaultEnvelopeV2ByDefault(t *testing.T) {
	ctx := context.Background()
	c := newClient(t, "ada")
	dan := newManagerEnv(t, "ada")
	dan.attachEmpty(t, "d")
	res, err := dan.m.Link(ctx, "d", "env-default-"+uuid.NewString()[:6], "private", "correct horse battery staple 42")
	if err != nil {
		t.Fatal(err)
	}
	if v := envelopeVersions(t, c, res.CloudVaultID); v[crypto.KindPassphrase] != 2 || v[crypto.KindRecovery] != 2 {
		t.Fatalf("the default must create v2 envelopes: %v", v)
	}
}

// ADR-0034: a vault created by a release N client (features.envelope_v2 off)
// has v1 envelopes; a device with the flag on (the release N+1 default) that
// unlocks upgrades the passphrase envelope to v2, then the recovery envelope
// when the recovery key is used; devices with the flag off still read v2, and
// a device that has seen v2 refuses a v1 envelope served in its place.
func TestPrivateVaultEnvelopeV2Migration(t *testing.T) {
	ctx := context.Background()
	const pass = "correct horse battery staple 42"
	c := newClient(t, "ada")

	// Release N behavior (flag off): created with v1 envelopes.
	ada := newManagerEnv(t, "ada")
	ada.m.SetEnvelopeV2(false)
	ada.attachEmpty(t, "v")
	res, err := ada.m.Link(ctx, "v", "env-"+uuid.NewString()[:6], "private", pass)
	if err != nil {
		t.Fatal(err)
	}
	cloud := res.CloudVaultID
	if v := envelopeVersions(t, c, cloud); v[crypto.KindPassphrase] != 1 || v[crypto.KindRecovery] != 1 {
		t.Fatalf("flag off must create v1 envelopes: %v", v)
	}

	// A device with the default configuration (flag on) unlocks and upgrades
	// the passphrase envelope; the recovery envelope waits for an unlock with
	// the recovery key.
	bob := newManagerEnv(t, "ada")
	bob.attachEmpty(t, "w")
	if err := bob.m.LinkExisting(ctx, "w", cloud); err != nil {
		t.Fatal(err)
	}
	if _, err := bob.m.Unlock(ctx, "w", pass, false); err != nil {
		t.Fatal(err)
	}
	if v := envelopeVersions(t, c, cloud); v[crypto.KindPassphrase] != 2 || v[crypto.KindRecovery] != 1 {
		t.Fatalf("after the upgrade: %v", v)
	}
	if _, err := bob.m.Unlock(ctx, "w", res.RecoveryKey, true); err != nil {
		t.Fatal(err)
	}
	if v := envelopeVersions(t, c, cloud); v[crypto.KindRecovery] != 2 {
		t.Fatalf("recovery envelope not upgraded: %v", v)
	}

	// A device with the flag off (an administrator's choice) reads v2 and,
	// once it has, keeps writing v2.
	carol := newManagerEnv(t, "ada")
	carol.m.SetEnvelopeV2(false)
	carol.attachEmpty(t, "x")
	if err := carol.m.LinkExisting(ctx, "x", cloud); err != nil {
		t.Fatal(err)
	}
	if _, err := carol.m.Unlock(ctx, "x", pass, false); err != nil {
		t.Fatalf("flag-off device on a v2 envelope: %v", err)
	}
	if err := carol.m.ChangePassphrase(ctx, "x", pass, pass+" changed"); err != nil {
		t.Fatal(err)
	}
	if v := envelopeVersions(t, c, cloud); v[crypto.KindPassphrase] != 2 {
		t.Fatalf("a change on a v2 vault must not downgrade: %v", v)
	}

	// A v1 envelope served in place of the pinned v2 (here the envelope of
	// another vault of the same user, same passphrase) is refused.
	other := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	mat, err := other.NewMaterial(pass + " changed")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range mat.Envelopes {
		if e.Kind == crypto.KindPassphrase {
			if err := c.PutKeyEnvelope(ctx, cloud, e); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := carol.m.LockVault(ctx, "x"); err != nil {
		t.Fatal(err)
	}
	if _, err := carol.m.Unlock(ctx, "x", pass+" changed", false); !errors.Is(err, crypto.ErrEnvelopeDowngrade) {
		t.Fatalf("downgraded envelope: %v", err)
	}
	// The recovery envelope was not replaced: the recovery key still opens the vault.
	if _, err := carol.m.Unlock(ctx, "x", res.RecoveryKey, true); err != nil {
		t.Fatalf("recovery after a refused downgrade: %v", err)
	}
}
