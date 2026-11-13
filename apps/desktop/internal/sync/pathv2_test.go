package sync

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/syncproto"
)

// newCryptoEngine is a private-vault engine with the real key manager (paths
// and blobs really encrypted), linked to lockCloud and bootstrapped.
func newCryptoEngine(t *testing.T, remote Remote) (*Engine, *crypto.Manager, *crypto.Cipher, string) {
	t.Helper()
	ctx := context.Background()
	e, dir := newTestEngine(t, remote, 0)
	cm := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	mat, err := cm.NewMaterial("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if err := cm.Adopt(lockCloud, mat); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{MetaCloudVault: lockCloud, MetaKind: "private", MetaBootstrapped: "1"} {
		if err := e.cfg.DB.SetMeta(ctx, k, v); err != nil {
			t.Fatal(err)
		}
	}
	c := cm.Cipher(lockCloud)
	cfg := e.cfg
	cfg.Cipher = c
	cfg.CacheDir = filepath.Join(t.TempDir(), "outbox")
	return New(cfg), cm, c, dir
}

// putEncrypted stores revision rev of a file on the script server, encrypted.
func putEncrypted(t *testing.T, r *scriptRemote, c *crypto.Cipher, fileID string, rev int, content string) string {
	t.Helper()
	ct, err := c.EncryptBlob(fileID, []byte(content))
	if err != nil {
		t.Fatal(err)
	}
	return r.put(fileID, rev, ct)
}

func pathToken(t *testing.T, c *crypto.Cipher, fileID, path string, v2 bool) string {
	t.Helper()
	tok, _, err := c.EncryptPath(fileID, path, v2)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func quarantinedIDs(t *testing.T, e *Engine) map[string]bool {
	t.Helper()
	q, err := e.cfg.DB.Quarantined(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, x := range q {
		out[x.FileID] = true
	}
	return out
}

// ADR-0042: enc2 tokens are read next to enc1 ones; a file seen in enc2 is
// pinned, so the server can no longer hand it another file's enc1 token, and
// an enc2 token of another file never opens. The vault pin keeps new tokens
// enc2 with features.path_v2 off (an administrator's choice since release N+1).
func TestPathV2PinRefusesSwapAndDowngrade(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, cm, c, dir := newCryptoEngine(t, remote)
	cm.SetPathV2(false)
	idA, idB := newFileID(), newFileID()
	tokA2 := pathToken(t, c, idA, "a.md", true)
	tokB1 := pathToken(t, c, idB, "b.md", false)
	remote.changes = []transport.Change{
		{Seq: 1, FileID: idA, Op: "create", Path: tokA2, Rev: 1, BlobHash: putEncrypted(t, remote, c, idA, 1, "# A")},
		{Seq: 2, FileID: idB, Op: "create", Path: tokB1, Rev: 1, BlobHash: putEncrypted(t, remote, c, idB, 1, "# B")},
	}
	if e.writePathV2(ctx) {
		t.Fatal("a vault without enc2 tokens must write enc1 while the flag is off")
	}
	e.pathPinLoaded = false
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if readFile(t, dir, "a.md") != "# A" || readFile(t, dir, "b.md") != "# B" {
		t.Fatal("enc1 and enc2 files not both applied")
	}
	if v, _ := e.cfg.DB.Meta(ctx, metaPathV2File(idA)); v != "1" {
		t.Fatal("file seen in enc2 not pinned")
	}
	if v, _ := e.cfg.DB.Meta(ctx, metaPathV2File(idB)); v != "" {
		t.Fatal("enc1 file pinned")
	}
	if v, _ := e.cfg.DB.Meta(ctx, metaPathV2(lockCloud)); v != "1" || !e.writePathV2(ctx) {
		t.Fatal("vault not pinned to enc2")
	}

	// The server serves file B's (enc1) token for file A: refused as a
	// downgrade. Then file A's enc2 token for file B: it does not open.
	remote.changes = append(remote.changes,
		transport.Change{Seq: 3, FileID: idA, Op: "modify", Path: tokB1, Rev: 2, BlobHash: putEncrypted(t, remote, c, idA, 2, "# A2")},
		transport.Change{Seq: 4, FileID: idB, Op: "modify", Path: tokA2, Rev: 2, BlobHash: putEncrypted(t, remote, c, idB, 2, "# B2")},
	)
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if q := quarantinedIDs(t, e); !q[idA] || !q[idB] {
		t.Fatalf("quarantined %v, want both files", q)
	}
	if readFile(t, dir, "a.md") != "# A" || readFile(t, dir, "b.md") != "# B" {
		t.Fatal("a swapped path token changed a local file")
	}
}

// New path tokens are enc1 with features.path_v2 off (the release N default),
// enc2 with it on, and the server holding an enc2 token we wrote pins the file
// and the vault.
func TestPathV2WriteFollowsFlag(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, cm, _, dir := newCryptoEngine(t, remote)
	if !cm.PathV2() {
		t.Fatal("features.path_v2 must be on by default (release N+1)")
	}
	cm.SetPathV2(false)
	writeFile(t, dir, "one.md", []byte("# one"))
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	cm.SetPathV2(true)
	writeFile(t, dir, "two.md", []byte("# two"))
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	paths := map[string]syncproto.Op{}
	for _, op := range remote.commits {
		if op.Op == syncproto.OpCreate {
			paths[op.Path[:5]] = op
		}
	}
	v1, ok1 := paths["enc1:"]
	v2, ok2 := paths["enc2:"]
	if !ok1 || !ok2 || len(remote.commits) != 2 {
		t.Fatalf("commits %+v: want one enc1 and one enc2 create", remote.commits)
	}
	if !strings.HasPrefix(v1.PathKey, "hmac1:") || !strings.HasPrefix(v2.PathKey, "hmac1:") {
		t.Fatal("path keys must stay hmac1 in both formats")
	}
	if v, _ := e.cfg.DB.Meta(ctx, metaPathV2File(v2.FileID)); v != "1" {
		t.Fatal("file written in enc2 not pinned after the server accepted it")
	}
	if v, _ := e.cfg.DB.Meta(ctx, metaPathV2File(v1.FileID)); v != "" {
		t.Fatal("file written in enc1 pinned")
	}
	// Flag off again: the vault is pinned, new tokens stay enc2.
	cm.SetPathV2(false)
	writeFile(t, dir, "three.md", []byte("# three"))
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	last := remote.commits[len(remote.commits)-1]
	if !strings.HasPrefix(last.Path, "enc2:") {
		t.Fatalf("pinned vault wrote %q", last.Path[:5])
	}
}
