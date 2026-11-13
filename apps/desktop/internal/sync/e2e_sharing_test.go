//go:build integration

package sync_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/crypto"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/apiclient"
	"clarae/shared/syncproto"
)

// M4-WP4: shares between users, mounts, permissions and revocation, against the real cloud binary.

func meOf(t *testing.T, user string) string {
	t.Helper()
	me, err := newClient(t, user).GetMe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return me.Id.String()
}

// groupOf creates a group holding the users (there is no admin API before M5, so rows go in directly).
func groupOf(t *testing.T, users ...string) string {
	t.Helper()
	pool := openDB(t)
	ctx := context.Background()
	id := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO groups (id, name) VALUES ($1, $2)`, id, "g-"+id.String()[:8]); err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		if _, err := pool.Exec(ctx, `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, id, meOf(t, u)); err != nil {
			t.Fatal(err)
		}
	}
	return id.String()
}

// shareFolder has owner share a folder of their cloud vault with the grants and returns the share id.
func shareFolder(t *testing.T, owner, vault, prefix string, grants ...transport.NewGrant) string {
	t.Helper()
	sh, err := newClient(t, owner).CreateShare(context.Background(), transport.CreateShare{
		VaultId: uuid.MustParse(vault), ResourceType: "folder", PathPrefix: &prefix, DisplayName: "Shared " + prefix, Grants: &grants,
	})
	if err != nil {
		t.Fatal(err)
	}
	return sh.Id.String()
}

// mountOf accepts the invitation as user and returns the mount the server lists.
func mountOf(t *testing.T, user, shareID string) transport.Mount {
	t.Helper()
	ctx := context.Background()
	c := newClient(t, user)
	if _, err := c.AcceptShare(ctx, shareID); err != nil {
		t.Fatal(err)
	}
	mounts, err := c.SharedWithMe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range mounts {
		if m.ShareId.String() == shareID {
			return m
		}
	}
	t.Fatalf("share %s is not a mount of %s", shareID, user)
	return transport.Mount{}
}

func mountDevice(t *testing.T, user, name string, m transport.Mount) *device {
	t.Helper()
	return newDeviceRef(t, user, name, transport.Ref(m.VaultId.String(), m.Scope), m.Permission == "viewer", nil)
}

func userGrant(t *testing.T, user, perm string) transport.NewGrant {
	return newGrant("user", meOf(t, user), perm)
}

func newGrant(ptype, pid, perm string) transport.NewGrant {
	return transport.NewGrant{PrincipalType: apiclient.NewGrantPrincipalType(ptype), PrincipalId: uuid.MustParse(pid), Permission: apiclient.SharePermission(perm)}
}

func TestSharedFolderRoundTripBetweenTwoUsers(t *testing.T) {
	vaultID := createVault(t, "ada", "shared-roundtrip")
	ownerDev := newDevice(t, "ada", "ada-laptop", vaultID, nil)
	plan := "line 1\nline 2\nline 3\nline 4\nline 5\n"
	ownerDev.write("Projects/Alfa/plan.md", plan)
	ownerDev.write("Projects/Alfa/board.canvas", `{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":100,"height":50,"text":"one"},{"id":"b","type":"text","x":200,"y":0,"width":100,"height":50,"text":"two"}],"edges":[]}`)
	ownerDev.write("Projects/Beta/secret.md", "not for bob")
	ownerDev.write("top.md", "also not for bob")
	ownerDev.sync()

	team := groupOf(t, "bob", "carol")
	share := shareFolder(t, "ada", vaultID, "Projects/Alfa", newGrant("group", team, "editor"))
	m := mountOf(t, "bob", share)
	if m.Permission != "editor" || m.Scope != "share:"+share {
		t.Fatalf("mount: %+v", m)
	}
	bobDev := mountDevice(t, "bob", "bob-laptop", m)
	bobDev.sync()

	// The mount holds the shared folder only, at its root.
	if got := strings.Join(sortedKeys(bobDev.files()), ","); got != "board.canvas,plan.md" {
		t.Fatalf("bob's mount: %s", got)
	}

	// Different lines of one note, edited by different people, merge.
	bobDev.write("plan.md", strings.Replace(plan, "line 1", "line 1 by bob", 1))
	ownerDev.write("Projects/Alfa/plan.md", strings.Replace(plan, "line 5", "line 5 by ada", 1))
	bobDev.sync()
	ownerDev.sync()
	bobDev.sync()
	want := strings.Replace(strings.Replace(plan, "line 1", "line 1 by bob", 1), "line 5", "line 5 by ada", 1)
	if got := ownerDev.read("Projects/Alfa/plan.md"); got != want {
		t.Errorf("owner: %q", got)
	}
	if got := bobDev.read("plan.md"); got != want {
		t.Errorf("bob: %q", got)
	}

	// A note created by the recipient lands in the shared folder of the owner.
	bobDev.write("notes/new.md", "from bob")
	bobDev.sync()
	ownerDev.sync()
	if got := ownerDev.read("Projects/Alfa/notes/new.md"); got != "from bob" {
		t.Errorf("owner did not receive the new note: %q", got)
	}
	// And the other way round.
	ownerDev.write("Projects/Alfa/from-ada.md", "from ada")
	ownerDev.sync()
	bobDev.sync()
	if got := bobDev.read("from-ada.md"); got != "from ada" {
		t.Errorf("bob did not receive: %q", got)
	}

	// Different authors editing a file that is not Markdown: never merged, always a conflict copy (D-04).
	ownerDev.write("Projects/Alfa/board.canvas", `{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":100,"height":50,"text":"one by ada"},{"id":"b","type":"text","x":200,"y":0,"width":100,"height":50,"text":"two"}],"edges":[]}`)
	bobDev.write("board.canvas", `{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":100,"height":50,"text":"one"},{"id":"b","type":"text","x":200,"y":0,"width":100,"height":50,"text":"two by bob"}],"edges":[]}`)
	ownerDev.sync()
	bobDev.sync()
	if got := bobDev.read("board.canvas"); !strings.Contains(got, "one by ada") || strings.Contains(got, "two by bob") {
		t.Errorf("the path keeps the version that reached the server first: %s", got)
	}
	var copyPath string
	for p, c := range bobDev.files() {
		if strings.HasPrefix(p, "board (conflitto") && strings.Contains(c, "two by bob") {
			copyPath = p
		}
	}
	if copyPath == "" || len(bobDev.conflicts) != 1 {
		t.Fatalf("bob's version must survive as a conflict copy: %v %v", sortedKeys(bobDev.files()), bobDev.conflicts)
	}

	// A file leaving the shared folder is a deletion for the recipient; one entering it appears.
	ownerDev.sync()
	ownerDev.rename("Projects/Alfa/from-ada.md", "Projects/Beta/from-ada.md")
	ownerDev.rename("Projects/Beta/secret.md", "Projects/Alfa/secret.md")
	ownerDev.sync()
	bobDev.sync()
	if bobDev.exists("from-ada.md") || bobDev.read("secret.md") != "not for bob" {
		t.Errorf("bob after the moves: %v", sortedKeys(bobDev.files()))
	}

	// What the recipient never had stays out of reach.
	if bobDev.exists("top.md") || bobDev.exists("Projects/Beta/secret.md") {
		t.Error("files outside the share leaked into the mount")
	}
	// A deletion by the recipient propagates.
	bobDev.remove("notes/new.md")
	bobDev.sync()
	ownerDev.sync()
	if ownerDev.exists("Projects/Alfa/notes/new.md") {
		t.Error("the recipient's deletion did not reach the owner")
	}
}

func TestViewerCannotWrite(t *testing.T) {
	vaultID := createVault(t, "ada", "shared-viewer")
	ownerDev := newDevice(t, "ada", "ada-laptop", vaultID, nil)
	ownerDev.write("Docs/readme.md", "read me")
	ownerDev.sync()
	share := shareFolder(t, "ada", vaultID, "Docs", userGrant(t, "dave", "viewer"))
	m := mountOf(t, "dave", share)
	viewer := mountDevice(t, "dave", "dave-laptop", m)
	viewer.sync()
	if viewer.read("readme.md") != "read me" {
		t.Fatal("a viewer reads")
	}

	// The engine of a viewer never sends anything...
	viewer.write("readme.md", "tampered")
	viewer.write("extra.md", "mine")
	viewer.sync()
	ownerDev.sync()
	if ownerDev.read("Docs/readme.md") != "read me" || ownerDev.exists("Docs/extra.md") {
		t.Error("a viewer's local edits must not reach the owner")
	}
	// ...and the server would refuse them anyway.
	_, err := newClient(t, "dave").Commit(context.Background(), transport.Ref(m.VaultId.String(), m.Scope), syncproto.CommitRequest{
		DeviceID: viewer.eng.DeviceID(),
		Ops:      []syncproto.Op{{OpID: uuid.NewString(), Op: syncproto.OpCreate, FileID: uuid.NewString(), Path: "x.md", BlobHash: strings.Repeat("0", 64)}},
	})
	if !transport.IsCode(err, syncproto.CodeForbidden) {
		t.Fatalf("the server must refuse a viewer's commit: %v", err)
	}
}

func TestRevokedShareStopsTheMount(t *testing.T) {
	vaultID := createVault(t, "ada", "shared-revoke")
	ownerDev := newDevice(t, "ada", "ada-laptop", vaultID, nil)
	ownerDev.write("Docs/a.md", "a")
	ownerDev.sync()
	share := shareFolder(t, "ada", vaultID, "Docs", userGrant(t, "erin", "editor"))
	m := mountOf(t, "erin", share)
	dev := mountDevice(t, "erin", "erin-laptop", m)
	dev.sync()

	if err := newClient(t, "ada").RevokeShare(context.Background(), share); err != nil {
		t.Fatal(err)
	}
	err := dev.eng.Sync(context.Background())
	if err == nil || !syncpkg.IsNotFound(err) {
		t.Fatalf("a revoked mount must fail with NOT_FOUND, got %v", err)
	}
	// The copy stays on disk: nothing is deleted behind the user's back.
	if dev.read("a.md") != "a" {
		t.Error("the mount's files must survive a revocation")
	}
}

// ---- the manager: the same flow the application drives ---------------------------

type testSession struct {
	c    *transport.Client
	info syncpkg.SessionInfo
}

func (s testSession) Client() *transport.Client         { return s.c }
func (s testSession) Info() (syncpkg.SessionInfo, bool) { return s.info, true }

type managerEnv struct {
	m      *syncpkg.Manager
	mu     stdsync.Mutex
	events []string
	user   string
	root   string
}

func (e *managerEnv) emitted(name string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := 0
	for _, ev := range e.events {
		if ev == name {
			n++
		}
	}
	return n
}

func newManagerEnv(t *testing.T, user string) *managerEnv {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := newClient(t, user)
	me, err := c.GetMe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := c.RegisterDevice(ctx, transport.DeviceRegistration{Name: user + "-mgr", Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	e := &managerEnv{user: user, root: t.TempDir()}
	sess := testSession{c: c, info: syncpkg.SessionInfo{ServerURL: serverURL, DeviceID: dev.Id.String(), UserID: me.Id.String(), DeviceName: user + "-mgr"}}
	e.m = syncpkg.NewManager(sess, crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore()}), zerolog.Nop(), func(name string, _ any) {
		e.mu.Lock()
		e.events = append(e.events, name)
		e.mu.Unlock()
	})
	e.m.Start(ctx)
	t.Cleanup(e.m.Shutdown)
	return e
}

func (e *managerEnv) openVault(t *testing.T, id, dir string) {
	t.Helper()
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.Attach(context.Background(), id, fs); err != nil {
		t.Fatal(err)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func fileHas(path, want string) func() bool {
	return func() bool { b, err := os.ReadFile(path); return err == nil && string(b) == want }
}

func TestManagerSharingFlow(t *testing.T) {
	ctx := context.Background()
	ada, bob := newManagerEnv(t, "ada"), newManagerEnv(t, "bob")

	// ada connects a vault and shares a folder with bob and a document with bob.
	adaDir := filepath.Join(ada.root, "vault")
	for p, c := range map[string]string{"Team/plan.md": "the plan", "Team/sub/deep.md": "deep", "Other/o.md": "other", "Notes/doc.md": "doc"} {
		abs := filepath.Join(adaDir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ada.openVault(t, "ada-vault", adaDir)
	if _, err := ada.m.Link(ctx, "ada-vault", "Company-"+uuid.NewString()[:6], "shared", ""); err != nil {
		t.Fatal(err)
	}
	eventually(t, "ada's vault to sync", func() bool {
		st, err := ada.m.Status(ctx, "ada-vault")
		return err == nil && st.Phase == syncpkg.PhaseIdle && !st.LastSync.IsZero() && st.Pending == 0
	})
	// Nothing to share until a document has been synchronized, then it works.
	shFolder, err := ada.m.CreateShare(ctx, "ada-vault", "Team", true, "Team files", []transport.NewGrant{userGrant(t, "bob", "editor")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	shDoc, err := ada.m.CreateShare(ctx, "ada-vault", "Notes/doc.md", false, "The doc", []transport.NewGrant{userGrant(t, "bob", "viewer")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ada.m.CreateShare(ctx, "ada-vault", "Nothing", true, "x", nil, nil); err == nil {
		t.Error("an empty folder cannot be shared")
	}
	if list, err := ada.m.VaultShares(ctx, "ada-vault"); err != nil || len(list) != 2 {
		t.Fatalf("the owner's shares: %v %v", list, err)
	}

	// bob sees two invitations, accepts both and gets two mounts.
	mountsDir := filepath.Join(bob.root, "mounts")
	invs, err := bob.m.Invitations(ctx)
	if err != nil || len(invs) < 2 {
		t.Fatalf("invitations: %v %v", invs, err)
	}
	mount, err := bob.m.AcceptShare(ctx, shFolder.Id.String(), mountsDir)
	if err != nil || mount.Permission != "editor" || !mount.Mounted {
		t.Fatalf("accept: %+v %v", mount, err)
	}
	docMount, err := bob.m.AcceptShare(ctx, shDoc.Id.String(), mountsDir)
	if err != nil || docMount.Permission != "viewer" {
		t.Fatalf("accept doc: %+v %v", docMount, err)
	}
	bob.openVault(t, "bob-team", mount.Path)
	bob.openVault(t, "bob-doc", docMount.Path)
	eventually(t, "the folder mount", fileHas(filepath.Join(mount.Path, "plan.md"), "the plan"))
	eventually(t, "the document mount", fileHas(filepath.Join(docMount.Path, "doc.md"), "doc"))
	if _, err := os.Stat(filepath.Join(mount.Path, "o.md")); err == nil {
		t.Error("the other folder must not be mounted")
	}

	// Rights as the UI will see them.
	info, _ := bob.m.Info(ctx, "bob-team")
	if !info.Mount || info.Permission != "editor" || info.ReadOnly || info.OwnerName != "ada" || info.Name != "Team files" {
		t.Fatalf("editor info: %+v", info)
	}
	if info, _ := bob.m.Info(ctx, "bob-doc"); !info.ReadOnly || info.Permission != "viewer" {
		t.Fatalf("viewer info: %+v", info)
	}
	if !bob.m.ReadOnly(ctx, "bob-doc") || bob.m.ReadOnly(ctx, "bob-team") || bob.m.Permission(ctx, "bob-team") != "editor" {
		t.Error("ReadOnly/Permission")
	}
	if info, _ := ada.m.Info(ctx, "ada-vault"); info.Mount || info.Permission != "owner" || info.ReadOnly {
		t.Fatalf("owner info: %+v", info)
	}

	// bob edits and ada receives it through her own manager.
	if err := os.WriteFile(filepath.Join(mount.Path, "plan.md"), []byte("the plan, edited by bob"), 0o644); err != nil {
		t.Fatal(err)
	}
	bob.m.Kick("bob-team")
	received := fileHas(filepath.Join(adaDir, "Team", "plan.md"), "the plan, edited by bob")
	eventually(t, "ada to receive bob's edit", func() bool {
		_ = ada.m.SyncNow("ada-vault") // no realtime stream in this test: ask instead of waiting for the poll
		return received()
	})

	// The server raises bob to manager: a reconcile applies it to the open mount.
	if _, err := newClient(t, "ada").PutGrant(ctx, shFolder.Id.String(), "user", meOf(t, "bob"), "manager"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the new level", func() bool {
		n, err := bob.m.ReconcileMounts(ctx, mountsDir)
		_ = n
		info, _ := bob.m.Info(ctx, "bob-team")
		return err == nil && info.Permission == "manager"
	})

	// Revocation: the mount stops, the UI is told, the copy stays.
	if err := newClient(t, "ada").RevokeShare(ctx, shFolder.Id.String()); err != nil {
		t.Fatal(err)
	}
	bob.m.Kick("bob-team")
	if err := bob.m.SyncNow("bob-team"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the revocation to be noticed", func() bool { return bob.emitted(syncpkg.EventMountRevoked.Name()) > 0 })
	info, _ = bob.m.Info(ctx, "bob-team")
	if !info.Revoked || !info.ReadOnly {
		t.Fatalf("revoked mount info: %+v", info)
	}
	states, err := bob.m.Mounts(ctx, mountsDir)
	if err != nil {
		t.Fatal(err)
	}
	var revoked bool
	for _, s := range states {
		revoked = revoked || (s.ShareID == shFolder.Id.String() && s.Revoked && s.Mounted)
	}
	if !revoked {
		t.Fatalf("the revoked mount must still be listed: %+v", states)
	}
	if b, _ := os.ReadFile(filepath.Join(mount.Path, "plan.md")); string(b) != "the plan, edited by bob" {
		t.Error("a revoked mount keeps its files")
	}
	// Keeping the copy turns it into an ordinary folder, as RemoveMount(keepCopy) does: the vault
	// is closed, the folder forgets its share and keeps its files.
	bob.m.Detach("bob-team")
	if err := syncpkg.ForgetMount(ctx, mount.Path); err != nil {
		t.Fatal(err)
	}
	if _, isMount, err := syncpkg.ReadMount(ctx, mount.Path); err != nil || isMount {
		t.Fatalf("a kept copy is not a mount any more: %v %v", isMount, err)
	}
	bob.openVault(t, "bob-kept", mount.Path)
	if info, _ := bob.m.Info(ctx, "bob-kept"); info.Linked {
		t.Fatalf("a kept copy is not linked any more: %+v", info)
	}
	if b, _ := os.ReadFile(filepath.Join(mount.Path, "plan.md")); string(b) != "the plan, edited by bob" {
		t.Error("a kept copy keeps its files")
	}
}

// A note written in an open vault before it is connected to the cloud is part of
// the first upload, for both kinds of vault (the browser workbench writes a note,
// then links the folder).
func TestManagerLinkUploadsFilesWrittenBeforeLinking(t *testing.T) {
	for _, kind := range []string{"shared", "private"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			env := newManagerEnv(t, "ada")
			dir := filepath.Join(env.root, "vault")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			fs, err := vault.NewFS(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err := env.m.Attach(ctx, "v", fs); err != nil {
				t.Fatal(err)
			}
			if _, err := fs.WriteFile("Before.md", []byte("written before linking\n"), "", true); err != nil {
				t.Fatal(err)
			}
			pass := ""
			if kind == "private" {
				pass = "correct horse battery staple 42"
			}
			res, err := env.m.Link(ctx, "v", "early-"+kind+"-"+uuid.NewString()[:6], kind, pass)
			if err != nil {
				t.Fatal(err)
			}
			c := newClient(t, "ada")
			eventually(t, "the note written before linking to reach the server", func() bool {
				_ = env.m.SyncNow("v")
				tree, err := c.GetTree(ctx, res.CloudVaultID)
				return err == nil && len(tree.Items) == 1
			})
			st, err := env.m.Status(ctx, "v")
			if err != nil || st.Pending != 0 {
				t.Fatalf("status after the first upload: %+v %v", st, err)
			}
		})
	}
}
