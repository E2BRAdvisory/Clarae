package sync

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

// Info is for the screens and shows what it can read; InfoStrict is for decisions and reports a meta table that
// cannot be read. A read that fails must not look like "not linked": the assistant of the editor opens only to
// a vault that is known to be shared (internal/app: AIAPI), and an unlinked vault is open to it.
func TestInfoStrictReportsAnUnreadableMetaTable(t *testing.T) {
	m := NewManager(offlineSession{}, nil, zerolog.Nop(), func(string, any) {})
	if err := m.Attach(context.Background(), "v", linkedVault(t)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach("v") })

	for name, read := range map[string]func(context.Context, string) (LinkInfo, error){"Info": m.Info, "InfoStrict": m.InfoStrict} {
		info, err := read(context.Background(), "v")
		if err != nil || !info.Linked || info.Kind != "shared" || info.CloudVaultID != "cloud-1" {
			t.Fatalf("%s of a readable link = %+v, %v", name, info, err)
		}
	}

	// A context that is over makes every read of the meta table fail, as a broken sync.db would.
	broken, cancel := context.WithCancel(context.Background())
	cancel()
	if info, err := m.Info(broken, "v"); err != nil || info.Linked {
		t.Fatalf("Info with an unreadable table = %+v, %v: it keeps its best-effort answer (not linked, no error)", info, err)
	}
	info, err := m.InfoStrict(broken, "v")
	if err == nil {
		t.Fatalf("InfoStrict with an unreadable table = %+v, nil: the failure was hidden", info)
	}
	if info != (LinkInfo{}) {
		t.Fatalf("InfoStrict returned a partial answer next to its error: %+v", info)
	}

	// A vault that is not open is an error for both.
	if _, err := m.InfoStrict(context.Background(), "nope"); err == nil {
		t.Fatal("InfoStrict of a vault that is not open returned no error")
	}
}
