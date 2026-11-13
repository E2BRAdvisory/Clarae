//go:build integration

package sync_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"clarae/apps/desktop/internal/crypto"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

// The rebrand of the configuration folder (ADR-0052, M17 C9) against the real cloud: a vault linked
// to the cloud keeps its synchronized settings in the former folder while a client of 1.x may share
// it, and features.config_dir_v2 moves them. A client of 1.x is simulated by what it does to the disk:
// it writes the former folder directly and knows nothing of the resolver; the sync layer it runs is
// the same one, which is what the protocol sees.

var (
	oldDir = pathrules.LegacyConfigDirs[0]
	newDir = pathrules.ConfigDir
)

// settingsOfOneX are the settings a vault of 1.x has synced.
var settingsOfOneX = map[string]string{
	"editor.json":        `{"fontSize":14}`,
	"hotkeys.json":       `{"save":"Mod-s"}`,
	"templates/daily.md": "# daily\n",
}

func (d *device) writeConfig(name, content string) {
	d.t.Helper()
	if _, err := d.fs.WriteConfig(name, []byte(content), "", false); err != nil {
		d.t.Fatalf("%s: WriteConfig %s: %v", d.name, name, err)
	}
}

func (d *device) readConfig(name string) string {
	d.t.Helper()
	c, err := d.fs.ReadConfig(name)
	if err != nil {
		d.t.Fatalf("%s: ReadConfig %s: %v", d.name, name, err)
	}
	return string(c.Data)
}

// asOneX makes the device a client of 1.x: it is linked, so new settings go to the former folder
// (the policy the application sets), and the move is off.
func (d *device) linked(moveOn bool) {
	d.t.Helper()
	d.fs.SetConfigPolicy(func() bool { return !moveOn })
	d.cfg.ConfigDirV2 = func() bool { return moveOn }
	d.eng = syncpkg.New(d.cfg)
}

// configFiles lists what the device holds in the two configuration folders (path -> content), local
// parts excluded.
func (d *device) configFiles() map[string]string {
	d.t.Helper()
	out := map[string]string{}
	for _, dir := range append([]string{newDir}, pathrules.LegacyConfigDirs...) {
		root := filepath.Join(d.dir, dir)
		_ = filepath.WalkDir(root, func(p string, de os.DirEntry, err error) error {
			if err != nil || de.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(d.dir, p)
			rel = filepath.ToSlash(rel)
			if pathrules.IsExcluded(rel, false) {
				return nil
			}
			b, _ := os.ReadFile(p)
			out[rel] = string(b)
			return nil
		})
	}
	return out
}

// clearServerPaths lists the paths of the vault's tree on the server in the clear (the tokens of a
// private vault are opened with the cipher of the device).
func (d *device) clearServerPaths() map[string]string {
	d.t.Helper()
	tree, err := d.client.GetTree(context.Background(), d.vaultID)
	if err != nil {
		d.t.Fatal(err)
	}
	out := map[string]string{} // path -> file id
	for _, it := range tree.Items {
		p := it.Path
		if d.cfg.Cipher != nil {
			if p, err = d.cfg.Cipher.DecryptFilePath(it.FileID, it.Path); err != nil {
				d.t.Fatalf("a path of the server cannot be read: %v", err)
			}
		}
		out[p] = it.FileID
	}
	return out
}

func (d *device) fileID(path string) string {
	d.t.Helper()
	row, ok, err := d.db.GetFile(context.Background(), path)
	if err != nil || !ok {
		d.t.Fatalf("%s: no row for %s (%v)", d.name, path, err)
	}
	return row.FileID
}

// cfgPair is two devices of one account on one vault, shared or private.
type cfgPair struct {
	v    string
	priv bool
	a, b *device
}

func newCfgPair(t *testing.T, private bool) *cfgPair {
	t.Helper()
	if !private {
		v := createVault(t, "ada", "cfgdir")
		return &cfgPair{v: v, a: newDevice(t, "ada", "new", v, nil), b: newDevice(t, "ada", "old", v, nil)}
	}
	ctx := context.Background()
	const pass = "correct horse battery staple"
	mgrA := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	mat, err := mgrA.NewMaterial(pass)
	if err != nil {
		t.Fatal(err)
	}
	client := newClient(t, "ada")
	pv, err := client.CreateVault(ctx, fmt.Sprintf("cfgdir-%d", time.Now().UnixNano()), "private", mat.Envelopes)
	if err != nil {
		t.Fatal(err)
	}
	vid := pv.Id.String()
	if err := mgrA.Adopt(vid, mat); err != nil {
		t.Fatal(err)
	}
	envs, err := client.GetKeyEnvelopes(ctx, vid)
	if err != nil {
		t.Fatal(err)
	}
	mgrB := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	if _, err := mgrB.Unlock(vid, envs, pass, false); err != nil {
		t.Fatal(err)
	}
	p := &cfgPair{v: vid, priv: true, a: newDevice(t, "ada", "new", vid, mgrA.Cipher(vid)), b: newDevice(t, "ada", "old", vid, mgrB.Cipher(vid))}
	p.a.linkMeta(vid)
	p.b.linkMeta(vid)
	return p
}

func (p *cfgPair) noConfigOnTheServer(t *testing.T, folder string, why string) {
	t.Helper()
	for path := range p.a.clearServerPaths() {
		if pathrules.HasPrefix(path, folder) {
			t.Errorf("%s: the server holds %s", why, path)
		}
	}
}

func noCopies(t *testing.T, d *device) {
	t.Helper()
	for p := range d.configFiles() {
		if strings.Contains(p, " (1)") || strings.Contains(p, "conflict") {
			t.Errorf("%s: a copy %s was made", d.name, p)
		}
	}
	if len(d.conflicts) != 0 {
		t.Errorf("%s: conflicts %+v", d.name, d.conflicts)
	}
}

// Case 1 and 4 (interoperability, flag off): a new client and a client of 1.x exchange settings in
// both directions, and the tree of the server holds nothing under the new name.
func TestConfigDirInteropWithTheFlagOff(t *testing.T) {
	for _, private := range []bool{false, true} {
		t.Run(map[bool]string{false: "shared", true: "private"}[private], func(t *testing.T) {
			p := newCfgPair(t, private)
			a, b := p.a, p.b
			a.linked(false)
			b.linked(false)

			// The new client writes through the resolver: the file goes where 1.x reads it.
			a.writeConfig("editor.json", `{"fontSize":15}`)
			a.sync()
			b.sync()
			if got := b.read(oldDir + "/editor.json"); got != `{"fontSize":15}` {
				t.Fatalf("the client of 1.x reads %q", got)
			}
			if b.exists(newDir + "/editor.json") {
				t.Fatal("a file appeared in the new folder of the client of 1.x")
			}

			// The client of 1.x writes in the former folder, a new file and a change.
			b.write(oldDir+"/hotkeys.json", `{"save":"Mod-s"}`)
			b.write(oldDir+"/editor.json", `{"fontSize":18}`)
			b.sync()
			a.sync()
			if got := a.readConfig("hotkeys.json"); got != `{"save":"Mod-s"}` {
				t.Fatalf("the new client reads hotkeys.json as %q", got)
			}
			if got := a.readConfig("editor.json"); got != `{"fontSize":18}` {
				t.Fatalf("the new client reads editor.json as %q", got)
			}
			// And back again: a write of the new client lands on the same file.
			a.writeConfig("editor.json", `{"fontSize":20}`)
			a.sync()
			b.sync()
			if got := b.read(oldDir + "/editor.json"); got != `{"fontSize":20}` {
				t.Fatalf("the client of 1.x reads %q", got)
			}
			for _, d := range []*device{a, b} {
				if d.exists(newDir+"/editor.json") || d.exists(newDir+"/hotkeys.json") {
					t.Fatalf("%s: a setting is in the new folder", d.name)
				}
				noCopies(t, d)
			}
			// The local part never leaves the device and the new name never reaches the server.
			p.noConfigOnTheServer(t, newDir, "flag off")
			if !a.exists(newDir + "/sync.db") {
				t.Fatal("the sync database of the new client is not in the new folder")
			}
		})
	}
}

// Case 2 and 4 (the move, flag on): two clients that both move their settings, even while neither
// has seen the other's move, end with the same files under the new name, with the file ids they
// had, with their history and without a copy; nothing is left under the former name.
func TestConfigDirMoveWithTheFlagOn(t *testing.T) {
	for _, private := range []bool{false, true} {
		t.Run(map[bool]string{false: "shared", true: "private"}[private], func(t *testing.T) {
			ctx := context.Background()
			p := newCfgPair(t, private)
			a, b := p.a, p.b
			a.linked(false)
			b.linked(false)
			// A vault of 1.x: its settings synced in the former folder, on both devices.
			for name, c := range settingsOfOneX {
				a.write(oldDir+"/"+name, c)
			}
			a.sync()
			b.sync()
			ids := map[string]string{}
			for name := range settingsOfOneX {
				ids[name] = a.fileID(oldDir + "/" + name)
				if b.fileID(oldDir+"/"+name) != ids[name] {
					t.Fatalf("%s: the devices disagree on the file id", name)
				}
			}

			// Every device runs 2.x and the administrator turns the flag on. Both move offline, at the
			// same time: neither has pushed when the other moves.
			a.linked(true)
			b.linked(true)
			a.sync()
			b.sync()
			for _, d := range []*device{a, b} {
				for name, c := range settingsOfOneX {
					if d.exists(oldDir+"/"+name) || d.read(newDir+"/"+name) != c {
						t.Fatalf("%s: %s did not move on disk", d.name, name)
					}
				}
			}
			for i := 0; i < 3; i++ { // converge
				a.sync()
				b.sync()
			}

			server := a.clearServerPaths()
			for name, c := range settingsOfOneX {
				for _, d := range []*device{a, b} {
					if got := d.readConfig(name); got != c {
						t.Errorf("%s: %s = %q", d.name, name, got)
					}
					if got := d.fileID(newDir + "/" + name); got != ids[name] {
						t.Errorf("%s: %s has file id %s, want %s", d.name, name, got, ids[name])
					}
				}
				if server[newDir+"/"+name] != ids[name] {
					t.Errorf("the server has %s under file id %q, want %s", name, server[newDir+"/"+name], ids[name])
				}
				// The history is the file's own: the revision written under the former name is still there.
				revs, _, err := a.client.ListRevisions(ctx, p.v, ids[name], 50, "")
				if err != nil || len(revs) < 2 {
					t.Errorf("%s: revisions %d (%v), want the content and the move", name, len(revs), err)
				}
			}
			p.noConfigOnTheServer(t, oldDir, "after the move")
			for _, d := range []*device{a, b} {
				noCopies(t, d)
				for path := range d.configFiles() {
					if pathrules.HasPrefix(path, oldDir) {
						t.Errorf("%s: %s is still in the former folder", d.name, path)
					}
				}
				if d.exists(oldDir) {
					t.Errorf("%s: the former folder is still there", d.name)
				}
			}
		})
	}
}

// Case 3 (a client of 1.x recreates the file): after the move the old client writes the former
// folder again. The new client keeps reading and writing the file under the new name, and the file
// it receives under the former name changes nothing, loses nothing and is not moved over the other.
func TestConfigDirRecreatedByTheOldClient(t *testing.T) {
	p := newCfgPair(t, false)
	a, b := p.a, p.b
	a.linked(false)
	b.linked(false)
	a.write(oldDir+"/editor.json", `{"fontSize":14}`)
	a.sync()
	b.sync()

	a.linked(true) // the new client moves; the old one follows the move of the server
	a.sync()
	a.sync()
	b.sync()
	if !b.exists(newDir+"/editor.json") || b.exists(oldDir+"/editor.json") {
		t.Fatalf("the move did not reach the second device: %v", sortedKeys(b.configFiles()))
	}
	// The user of the old client changes a setting: it recreates the former file.
	b.write(oldDir+"/editor.json", `{"fontSize":99}`)
	b.sync()
	for i := 0; i < 3; i++ {
		a.sync()
	}
	if got := a.readConfig("editor.json"); got != `{"fontSize":14}` {
		t.Fatalf("the canonical file changed: %q", got)
	}
	if got := a.read(oldDir + "/editor.json"); got != `{"fontSize":99}` {
		t.Fatalf("the recreated file is not kept: %q", got)
	}
	// A write of the new client goes to the canonical file, and the former one is not moved over it.
	a.writeConfig("editor.json", `{"fontSize":16}`)
	for i := 0; i < 3; i++ {
		a.sync()
	}
	if a.read(newDir+"/editor.json") != `{"fontSize":16}` || a.read(oldDir+"/editor.json") != `{"fontSize":99}` {
		t.Fatalf("A holds %v", a.configFiles())
	}
	noCopies(t, a)
}

// Case 5: a client puts a sync.db of its own under the new name in a private vault (the cloud cannot
// read paths there, an older client has no rule against it). The other device does not write it, its
// own sync.db stays the one it uses, and its sync goes on.
func TestPrivateVaultDoesNotWriteAnExcludedRemotePath(t *testing.T) {
	ctx := context.Background()
	p := newCfgPair(t, true)
	a, b := p.a, p.b
	a.write("note.md", "# note\n")
	a.sync()
	b.sync()

	planted := map[string]string{newDir + "/sync.db": "NOT A DATABASE", newDir + "/index.db-wal": "wal", oldDir + "/sync.db": "legacy"}
	cipher := a.cfg.Cipher
	var ops []syncproto.Op
	for path, content := range planted {
		fid := uuid.Must(uuid.NewV7()).String()
		tok, key, err := cipher.EncryptPath(fid, path, true)
		if err != nil {
			t.Fatal(err)
		}
		blob, err := cipher.EncryptBlob(fid, []byte(content))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(blob)
		hash := hex.EncodeToString(sum[:])
		if err := a.client.PutBlob(ctx, p.v, hash, blob); err != nil {
			t.Fatal(err)
		}
		ops = append(ops, syncproto.Op{OpID: uuid.Must(uuid.NewV7()).String(), Op: syncproto.OpCreate, FileID: fid, Path: tok, PathKey: key, BlobHash: hash, Size: int64(len(blob))})
	}
	resp, err := a.client.Commit(ctx, p.v, syncproto.CommitRequest{DeviceID: a.eng.DeviceID(), Ops: ops})
	if err != nil || len(resp.Results) != len(ops) {
		t.Fatalf("commit: %+v %v", resp, err)
	}
	for _, r := range resp.Results {
		if r.Status != syncproto.StatusAccepted {
			t.Fatalf("the server refused a planted path: %+v", r)
		}
	}

	b.sync()
	b.sync()
	for path, content := range planted {
		if b.exists(path) && b.read(path) == content {
			t.Errorf("%s was written on the device", path)
		}
	}
	// The device's own database still works and still knows its vault.
	if got := b.meta(syncpkg.MetaCloudVault); got != p.v {
		t.Fatalf("the link of the device is lost: %q", got)
	}
	head := make([]byte, 16)
	f, err := os.Open(filepath.Join(b.dir, newDir, "sync.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if _, err := f.Read(head); err != nil || string(head) != "SQLite format 3\x00" {
		t.Fatalf("the sync database was replaced: %q %v", head, err)
	}
	if q, err := b.db.Quarantined(ctx); err != nil || len(q) != 0 {
		t.Fatalf("quarantine: %+v %v", q, err)
	}
	// It goes on synchronizing.
	a.write("later.md", "# later\n")
	a.sync()
	b.sync()
	if b.read("later.md") != "# later\n" {
		t.Fatal("the device stopped synchronizing")
	}
}

// Case 6: a mount folder that 1.x made (its link in the former folder, under mounts/) is migrated
// when it is read and opened, and stays attached to its share.
func TestMountFolderOfOneXStaysMounted(t *testing.T) {
	ctx := context.Background()
	ada, bob := newManagerEnv(t, "ada"), newManagerEnv(t, "bob")
	adaDir := filepath.Join(ada.root, "vault")
	if err := os.MkdirAll(filepath.Join(adaDir, "Team"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(adaDir, "Team", "plan.md"), []byte("the plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	ada.openVault(t, "ada-vault", adaDir)
	if _, err := ada.m.Link(ctx, "ada-vault", "Company-"+uuid.NewString()[:6], "shared", ""); err != nil {
		t.Fatal(err)
	}
	eventually(t, "ada's vault to sync", func() bool {
		st, err := ada.m.Status(ctx, "ada-vault")
		return err == nil && st.Phase == syncpkg.PhaseIdle && !st.LastSync.IsZero() && st.Pending == 0
	})
	sh, err := ada.m.CreateShare(ctx, "ada-vault", "Team", true, "Team files", []transport.NewGrant{userGrant(t, "bob", "editor")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mountsDir := filepath.Join(bob.root, "mounts")
	mount, err := bob.m.AcceptShare(ctx, sh.Id.String(), mountsDir)
	if err != nil || !mount.Mounted {
		t.Fatalf("accept: %+v %v", mount, err)
	}
	// What 1.x left on disk: the link in the former folder.
	if err := os.Rename(filepath.Join(mount.Path, newDir), filepath.Join(mount.Path, oldDir)); err != nil {
		t.Fatal(err)
	}

	// Read while closed: still a mount (it used to be taken for a plain folder).
	mm, isMount, err := syncpkg.ReadMount(ctx, mount.Path)
	if err != nil || !isMount || mm.ShareID != sh.Id.String() || mm.Permission != "editor" {
		t.Fatalf("ReadMount = %+v %v %v", mm, isMount, err)
	}
	if n, err := bob.m.ReconcileMounts(ctx, mountsDir); err != nil || n != 0 {
		t.Fatalf("ReconcileMounts changed %d (%v): the share is live", n, err)
	}
	if _, err := os.Stat(filepath.Join(mount.Path, newDir, "sync.db")); err != nil {
		t.Fatalf("the link did not move to the new folder: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mount.Path, oldDir, "sync.db")); !os.IsNotExist(err) {
		t.Fatalf("the link is still in the former folder: %v", err)
	}

	// Opened, it syncs with its share, and still is the mount of that share.
	bob.openVault(t, "bob-team", mount.Path)
	eventually(t, "the mount to receive the share", fileHas(filepath.Join(mount.Path, "plan.md"), "the plan"))
	info, err := bob.m.Info(ctx, "bob-team")
	if err != nil || !info.Mount || info.Permission != "editor" || info.Name != "Team files" || info.Revoked {
		t.Fatalf("mount info: %+v %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(mount.Path, "plan.md"), []byte("the plan, edited by bob"), 0o644); err != nil {
		t.Fatal(err)
	}
	bob.m.Kick("bob-team")
	received := fileHas(filepath.Join(adaDir, "Team", "plan.md"), "the plan, edited by bob")
	eventually(t, "ada to receive bob's edit", func() bool {
		_ = ada.m.SyncNow("ada-vault")
		return received()
	})
}
