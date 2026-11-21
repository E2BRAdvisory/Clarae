package sync

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

// The room of a file is the cloud vault and the server's id of the file; the path of a mount is
// relative to the share, as in its sync.db; a private vault, a vault that is not linked, a revoked mount
// and a file that was never synced have none.
func TestPresenceTarget(t *testing.T) {
	ctx := context.Background()
	m := NewManager(offlineSession{}, nil, zerolog.Nop(), nil)
	put := func(id, path, fileID string, tomb bool) {
		t.Helper()
		mv, err := m.get(id)
		if err != nil {
			t.Fatal(err)
		}
		if err := mv.db.PutFile(ctx, File{Path: path, FileID: fileID, ServerRev: 1, State: StateSynced, Tombstoned: tomb}); err != nil {
			t.Fatal(err)
		}
	}
	attach(t, m, "own", linkedVault(t)) // kind shared, cloud-1
	put("own", "a.md", "file-a", false)
	put("own", "draft.md", "", false)
	put("own", "gone.md", "file-gone", true)
	mdir := t.TempDir()
	attach(t, m, "mount", mountAt(t, mdir, mountShareA, lifeOwner))
	put("mount", "sub/a.md", "file-m", false)

	cases := []struct {
		vault, path, cloud, file, reason string
	}{
		{"own", "a.md", "cloud-1", "file-a", ""},
		{"own", "draft.md", "", "", PresenceNotSynced},
		{"own", "gone.md", "", "", PresenceNotSynced},
		{"own", "unknown.md", "", "", PresenceNotSynced},
		{"mount", "sub/a.md", mountCloud, "file-m", ""},
		{"nope", "a.md", "", "", PresenceNotShared},
	}
	for _, c := range cases {
		cloud, file, reason := m.PresenceTarget(ctx, c.vault, c.path)
		if cloud != c.cloud || file != c.file || reason != c.reason {
			t.Errorf("%s/%s = (%q, %q, %q), want (%q, %q, %q)", c.vault, c.path, cloud, file, reason, c.cloud, c.file, c.reason)
		}
	}

	// A private vault never has presence, whatever the file.
	mv, _ := m.get("own")
	if err := mv.db.SetMeta(ctx, MetaKind, "private"); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	mv.kind = "private"
	m.mu.Unlock()
	if _, _, reason := m.PresenceTarget(ctx, "own", "a.md"); reason != PresenceNotShared {
		t.Errorf("private vault: reason %q", reason)
	}
	// A revoked mount neither.
	mm, _ := m.get("mount")
	if err := mm.db.SetMeta(ctx, MetaRevoked, "1"); err != nil {
		t.Fatal(err)
	}
	if _, _, reason := m.PresenceTarget(ctx, "mount", "sub/a.md"); reason != PresenceNotShared {
		t.Errorf("revoked mount: reason %q", reason)
	}
}
