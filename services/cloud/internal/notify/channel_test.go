package notify_test

import (
	"testing"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/notify"
)

// notify owns the vault_changed protocol (Channel, FormatMessage,
// PublishVaultChanged): the commit publishes through PublishVaultChanged, so
// the payload the hub parses is the one that is written.
func TestVaultChangedPayloadRoundTrips(t *testing.T) {
	if notify.Channel != "vault_changed" {
		t.Fatalf("channel renamed: %q", notify.Channel)
	}
	id := uuid.New()
	if ev, ok := notify.ParseMessage(notify.FormatMessage(id, 12)); !ok || ev.VaultID != id || ev.Seq != 12 || notify.FormatMessage(id, 12) != id.String()+":12" {
		t.Fatal("the vault_changed payload format changed")
	}
}
