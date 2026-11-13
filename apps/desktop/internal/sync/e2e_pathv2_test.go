//go:build integration

package sync_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"clarae/apps/desktop/internal/crypto"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/shared/syncproto"
	"clarae/shared/vaultcrypto"
)

// tokenVersions counts the path token formats of a vault's tree on the server.
func tokenVersions(t *testing.T, d *device) (enc1, enc2 int, byID map[string]string) {
	t.Helper()
	tree, err := d.client.GetTree(context.Background(), d.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	byID = map[string]string{}
	for _, it := range tree.Items {
		byID[it.FileID] = it.Path
		switch vaultcrypto.PathTokenVersion(it.Path) {
		case 1:
			enc1++
		case 2:
			enc2++
		}
	}
	return enc1, enc2, byID
}

func (d *device) meta(key string) string {
	d.t.Helper()
	v, err := d.db.Meta(context.Background(), key)
	if err != nil {
		d.t.Fatal(err)
	}
	return v
}

// linkMeta records the cloud vault in sync.db as Manager.Link does: the
// path token pins and the migration are keyed by it.
func (d *device) linkMeta(cloudID string) {
	d.t.Helper()
	for k, v := range map[string]string{syncpkg.MetaCloudVault: cloudID, syncpkg.MetaKind: "private"} {
		if err := d.db.SetMeta(context.Background(), k, v); err != nil {
			d.t.Fatal(err)
		}
	}
}

// ADR-0042 release N+1 against the real cloud: a private vault written by a
// release N client (features.path_v2 off) has enc1 tokens; a client with the
// default configuration rewrites them as enc2 in batches and sets the strong
// pin once the tree has none left; an enc1 token after that is quarantined;
// the client with the flag off still reads everything and, the vault being
// pinned, writes enc2.
func TestPrivateVaultPathMigration(t *testing.T) {
	ctx := context.Background()
	const pass = "correct horse battery staple"
	off := false
	mgrA := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond, PathV2: &off, EnvelopeV2: &off})
	mat, err := mgrA.NewMaterial(pass)
	if err != nil {
		t.Fatal(err)
	}
	client := newClient(t, "ada")
	pv, err := client.CreateVault(ctx, fmt.Sprintf("pathv2-%d", time.Now().UnixNano()), "private", mat.Envelopes)
	if err != nil {
		t.Fatal(err)
	}
	vid := pv.Id.String()
	if err := mgrA.Adopt(vid, mat); err != nil {
		t.Fatal(err)
	}
	a := newDevice(t, "ada", "release-n", vid, mgrA.Cipher(vid))
	a.linkMeta(vid)
	files := map[string]string{
		"one.md": "# One\n", "two.md": "# Two\n", "Journal/three.md": "# Three\n",
		"Journal/Deep/four.md": "# Four\n", "five.canvas": `{"nodes":[],"edges":[]}`,
	}
	for p, c := range files {
		a.write(p, c)
	}
	a.sync()
	if enc1, enc2, _ := tokenVersions(t, a); enc1 != len(files) || enc2 != 0 {
		t.Fatalf("release N client wrote %d enc1 and %d enc2 tokens", enc1, enc2)
	}

	// A release N+1 client (default configuration) unlocks the vault.
	envs, err := client.GetKeyEnvelopes(ctx, vid)
	if err != nil {
		t.Fatal(err)
	}
	mgrB := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	if !mgrB.PathV2() {
		t.Fatal("features.path_v2 must be on by default")
	}
	if _, err := mgrB.Unlock(vid, envs, pass, false); err != nil {
		t.Fatal(err)
	}
	b := newDevice(t, "ada", "release-n1", vid, mgrB.Cipher(vid))
	b.linkMeta(vid)
	b.cfg.PathMigrationBatch, b.cfg.PathMigrationSpacing = 2, time.Nanosecond
	b.eng = syncpkg.New(b.cfg)
	strong := "path_v2_strong:" + vid
	prev := len(files)
	for i := 0; i < 10 && b.meta(strong) != "1"; i++ {
		b.sync()
		enc1, _, _ := tokenVersions(t, b)
		if prev-enc1 > 2 {
			t.Fatalf("a batch rewrote %d tokens, want at most 2", prev-enc1)
		}
		if enc1 > 0 && b.meta(strong) == "1" {
			t.Fatalf("strong pin with %d enc1 tokens left", enc1)
		}
		prev = enc1
	}
	if enc1, enc2, _ := tokenVersions(t, b); enc1 != 0 || enc2 != len(files) || b.meta(strong) != "1" {
		t.Fatalf("after the migration: %d enc1, %d enc2, strong pin %q", enc1, enc2, b.meta(strong))
	}
	for p, c := range files {
		if b.read(p) != c {
			t.Fatalf("B reads %s as %q", p, b.read(p))
		}
	}
	if len(b.conflicts) != 0 {
		t.Fatalf("the migration produced conflicts: %+v", b.conflicts)
	}

	// An enc1 token after the strong pin (an outdated client, or a server
	// swapping tokens) is quarantined on B; the local files stay as they are.
	fid := uuid.Must(uuid.NewV7()).String()
	cA := mgrA.Cipher(vid)
	tok, key, err := cA.EncryptPath(fid, "late.md", false)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := cA.EncryptBlob(fid, []byte("# Late\n"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(blob)
	hash := hex.EncodeToString(sum[:])
	if err := client.PutBlob(ctx, vid, hash, blob); err != nil {
		t.Fatal(err)
	}
	resp, err := client.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: a.eng.DeviceID(), Ops: []syncproto.Op{{
		OpID: uuid.Must(uuid.NewV7()).String(), Op: syncproto.OpCreate, FileID: fid, Path: tok, PathKey: key, BlobHash: hash, Size: int64(len(blob)),
	}}})
	if err != nil || len(resp.Results) != 1 || resp.Results[0].Status != syncproto.StatusAccepted {
		t.Fatalf("enc1 commit: %+v %v", resp, err)
	}
	b.sync()
	q, err := b.db.Quarantined(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(q) != 1 || q[0].FileID != fid || b.exists("late.md") {
		t.Fatalf("quarantine %+v, late.md on B: %t", q, b.exists("late.md"))
	}
	for p, c := range files {
		if b.read(p) != c {
			t.Fatalf("B's %s changed after the quarantine: %q", p, b.read(p))
		}
	}

	// The client with the flag off reads the migrated vault (no change on its
	// disk) and, now pinned to enc2, writes enc2.
	a.sync()
	for p, c := range files {
		if a.read(p) != c {
			t.Fatalf("A reads %s as %q after the migration", p, a.read(p))
		}
	}
	if a.meta("path_v2:"+vid) != "1" {
		t.Fatal("the flag-off client did not pin the vault after reading enc2 tokens")
	}
	a.write("from-a.md", "# From A\n")
	a.sync()
	row, ok, err := a.db.GetFile(ctx, "from-a.md")
	if err != nil || !ok {
		t.Fatalf("from-a.md not tracked: %v", err)
	}
	if _, _, byID := tokenVersions(t, a); !strings.HasPrefix(byID[row.FileID], "enc2:") {
		t.Fatalf("flag-off client on a pinned vault wrote %q", byID[row.FileID])
	}
	b.sync()
	if b.read("from-a.md") != "# From A\n" {
		t.Fatal("B does not read the enc2 file of the flag-off client")
	}
}
