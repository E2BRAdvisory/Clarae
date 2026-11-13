//go:build integration

package sync_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"clarae/apps/desktop/internal/crypto"
)

// Folder renames against the real cloud binary (ADR-0040): one move_prefix in
// shared vaults (the share follows the folder, the recipient keeps syncing),
// per-file moves in private vaults, SHARE_ROOT_MOVE recovered or parked.

func shareRoot(t *testing.T, shareID string) string {
	t.Helper()
	sh, err := newClient(t, "ada").GetShare(context.Background(), shareID)
	if err != nil {
		t.Fatal(err)
	}
	if sh.PathPrefix == nil {
		return ""
	}
	return *sh.PathPrefix
}

// changeOps counts the operations of the changelog after since.
func changeOps(t *testing.T, d *device, since int64) map[string]int {
	t.Helper()
	ch, err := d.client.GetChanges(context.Background(), d.vaultID, since, "", 500)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]int{}
	for _, c := range ch.Items {
		out[c.Op]++
	}
	return out
}

func lastSeq(t *testing.T, d *device) int64 {
	t.Helper()
	ch, err := d.client.GetChanges(context.Background(), d.vaultID, 0, "", 500)
	if err != nil {
		t.Fatal(err)
	}
	return ch.NextSeq
}

func TestSharedFolderRenameIsAFolderRenameEverywhere(t *testing.T) {
	v := createVault(t, "ada", "folder-rename")
	a := newDevice(t, "ada", "ada-laptop", v, nil)
	b := newDevice(t, "ada", "ada-desktop", v, nil)
	plan := lines(6, "plan")
	a.write("Projects/Alfa/plan.md", plan)
	a.write("Projects/Alfa/sub/notes.md", "notes\n")
	a.write("Projects/Alfa/sub/pic.png", "png")
	a.write("Projects/Beta/other.md", "other\n")
	a.sync()
	b.sync()
	share := shareFolder(t, "ada", v, "Projects/Alfa", userGrant(t, "bob", "editor"))
	bob := mountDevice(t, "bob", "bob-laptop", mountOf(t, "bob", share))
	bob.sync()
	if got := strings.Join(sortedKeys(bob.files()), ","); got != "plan.md,sub/notes.md,sub/pic.png" {
		t.Fatalf("bob's mount: %s", got)
	}

	since := lastSeq(t, a)
	a.rename("Projects/Alfa", "Projects/Alfa 2024")
	a.sync()
	if got := changeOps(t, a, since); got["move"] != 3 || len(got) != 1 {
		t.Fatalf("changelog after the rename: %v, want three moves", got)
	}
	if got := shareRoot(t, share); got != "Projects/Alfa 2024" {
		t.Fatalf("the share did not follow the folder: %q", got)
	}

	// The other device of the owner renames its folder: no split, no duplicates.
	b.sync()
	if fmt.Sprint(sortedKeys(a.files())) != fmt.Sprint(sortedKeys(b.files())) {
		t.Fatalf("devices diverge:\nA %v\nB %v", sortedKeys(a.files()), sortedKeys(b.files()))
	}
	if b.exists("Projects/Alfa") || b.read("Projects/Alfa 2024/sub/notes.md") != "notes\n" {
		t.Fatalf("B: %v", sortedKeys(b.files()))
	}

	// The recipient keeps its mount as it was (nothing deleted, nothing downloaded twice) and goes on syncing.
	bob.sync()
	if got := strings.Join(sortedKeys(bob.files()), ","); got != "plan.md,sub/notes.md,sub/pic.png" {
		t.Fatalf("bob's mount after the rename: %s", got)
	}
	if bob.exists(".trash/plan.md") {
		t.Error("the recipient saw the rename as deletions")
	}
	bob.write("plan.md", replaceLine(plan, 2, "plan 2 by bob"))
	bob.sync()
	a.sync()
	if got := a.read("Projects/Alfa 2024/plan.md"); got != replaceLine(plan, 2, "plan 2 by bob") {
		t.Fatalf("the recipient's edit after the rename: %q", got)
	}

	// A rename inside the share reaches the recipient as a folder rename of its mount.
	a.rename("Projects/Alfa 2024/sub", "Projects/Alfa 2024/Sub folder")
	a.sync()
	bob.sync()
	if got := strings.Join(sortedKeys(bob.files()), ","); got != "Sub folder/notes.md,Sub folder/pic.png,plan.md" || bob.exists("sub") {
		t.Fatalf("bob after the inner rename: %s", got)
	}
	// Moved out of the share: deletions for the recipient.
	a.rename("Projects/Alfa 2024/Sub folder", "Projects/Beta/Sub folder")
	a.sync()
	bob.sync()
	if got := strings.Join(sortedKeys(bob.files()), ","); got != "plan.md" {
		t.Fatalf("bob after the move out: %s", got)
	}
	b.sync()
	if fmt.Sprint(sortedKeys(a.files())) != fmt.Sprint(sortedKeys(b.files())) {
		t.Fatalf("devices diverge:\nA %v\nB %v", sortedKeys(a.files()), sortedKeys(b.files()))
	}
}

// A case-only rename of a shared folder (ADR-0040).
func TestSharedFolderCaseOnlyRename(t *testing.T) {
	v := createVault(t, "ada", "folder-case")
	a := newDevice(t, "ada", "ada-laptop", v, nil)
	b := newDevice(t, "ada", "ada-desktop", v, nil)
	a.write("notes/one.md", "one\n")
	a.write("notes/two.md", "two\n")
	a.sync()
	b.sync()
	share := shareFolder(t, "ada", v, "notes", userGrant(t, "bob", "viewer"))
	a.rename("notes", "notes-tmp")
	a.rename("notes-tmp", "Notes")
	a.sync()
	if got := shareRoot(t, share); got != "Notes" {
		t.Fatalf("share root %q", got)
	}
	b.sync()
	if got := strings.Join(sortedKeys(b.files()), ","); got != "Notes/one.md,Notes/two.md" {
		t.Fatalf("B: %s", got)
	}
}

func TestPrivateFolderRenameWithPerFileMoves(t *testing.T) {
	ctx := context.Background()
	mgr := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	mat, err := mgr.NewMaterial("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	pv, err := newClient(t, "ada").CreateVault(ctx, fmt.Sprintf("diary-folders-%d", time.Now().UnixNano()), "private", mat.Envelopes)
	if err != nil {
		t.Fatal(err)
	}
	vid := pv.Id.String()
	if err := mgr.Adopt(vid, mat); err != nil {
		t.Fatal(err)
	}
	a := newDevice(t, "ada", "laptop", vid, mgr.Cipher(vid))
	b := newDevice(t, "ada", "desktop", vid, mgr.Cipher(vid))
	a.write("Journal/2025/jan.md", "january\n")
	a.write("Journal/2025/feb.md", "february\n")
	a.write("Journal/index.md", "index\n")
	a.sync()
	b.sync()

	since := lastSeq(t, a)
	a.rename("Journal", "Diary")
	a.sync()
	if got := changeOps(t, a, since); got["move"] != 3 || len(got) != 1 {
		t.Fatalf("changelog after the rename: %v, want three moves", got)
	}
	b.sync()
	if got := strings.Join(sortedKeys(b.files()), ","); got != "Diary/2025/feb.md,Diary/2025/jan.md,Diary/index.md" || b.exists("Journal") {
		t.Fatalf("B: %s", got)
	}
	// The paths on the server stay opaque.
	tree, err := a.client.GetTree(ctx, vid)
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range tree.Items {
		if strings.Contains(it.Path, "Diary") || it.Kind != "opaque" {
			t.Errorf("server sees %+v", it)
		}
	}
}

// SHARE_ROOT_MOVE: the last file of a shared folder moved out one by one (the
// folder stays on disk). When the file kept its place below the folder's new
// name, the engine renames the share root instead; otherwise the move is
// parked, the status says why and nothing is lost.
func TestShareRootMoveAgainstTheServer(t *testing.T) {
	v := createVault(t, "ada", "share-root-move")
	a := newDevice(t, "ada", "ada-laptop", v, nil)
	a.write("Docs/readme.md", "read me\n")
	a.write("Talks/slides.md", "slides\n")
	a.write("top.md", "top\n")
	a.sync()
	docs := shareFolder(t, "ada", v, "Docs", userGrant(t, "bob", "editor"))
	talks := shareFolder(t, "ada", v, "Talks", userGrant(t, "bob", "editor"))
	bob := mountDevice(t, "bob", "bob-laptop", mountOf(t, "bob", docs))
	bob.sync()

	a.rename("Docs/readme.md", "Documents/readme.md") // Docs stays on disk, empty: a per-file move
	a.sync()
	if got := shareRoot(t, docs); got != "Documents" {
		t.Fatalf("share root %q, want Documents", got)
	}
	if st := a.eng.Status(); st.Error != "" {
		t.Fatalf("status %+v", st)
	}
	bob.sync()
	if got := strings.Join(sortedKeys(bob.files()), ","); got != "readme.md" {
		t.Fatalf("bob: %s", got)
	}

	// Not a rename of the root: parked, explained, kept.
	a.rename("Talks/slides.md", "slides-2024.md")
	a.sync()
	st := a.eng.Status()
	if !strings.Contains(st.Error, "shared folder") || !strings.Contains(st.Error, "slides-2024.md") {
		t.Fatalf("status %+v", st)
	}
	if a.read("slides-2024.md") != "slides\n" || shareRoot(t, talks) != "Talks" {
		t.Fatal("the parked move lost something")
	}
	a.rename("slides-2024.md", "Talks/slides.md")
	a.sync()
	if st := a.eng.Status(); st.Error != "" {
		t.Fatalf("status after moving back %+v", st)
	}
}

// A note edited on one device while its folder is renamed on the other: both
// changes survive, at the new path, everywhere.
func TestConcurrentEditInsideARenamedSharedFolder(t *testing.T) {
	v := createVault(t, "ada", "folder-rename-edit")
	a := newDevice(t, "ada", "ada-laptop", v, nil)
	b := newDevice(t, "ada", "ada-desktop", v, nil)
	base := lines(6, "line")
	a.write("Team/plan.md", base)
	a.write("Team/todo.md", "todo\n")
	a.sync()
	b.sync()

	// A renames the folder from the UI (the hint keeps the identity of the
	// note it also edits); B edits another line of the same note meanwhile.
	a.rename("Team", "Team 2024")
	if err := a.eng.Renamed(context.Background(), "Team", "Team 2024"); err != nil {
		t.Fatal(err)
	}
	a.write("Team 2024/plan.md", replaceLine(base, 6, "line 6 by A"))
	b.write("Team/plan.md", replaceLine(base, 3, "line 3 by B"))
	a.sync()
	b.sync()
	a.sync()
	want := replaceLine(replaceLine(base, 3, "line 3 by B"), 6, "line 6 by A")
	for _, d := range []*device{a, b} {
		if got := d.read("Team 2024/plan.md"); got != want {
			t.Errorf("%s: %q, want %q", d.name, got, want)
		}
		if got := strings.Join(sortedKeys(d.files()), ","); got != "Team 2024/plan.md,Team 2024/todo.md" {
			t.Errorf("%s: %s", d.name, got)
		}
	}
	if len(a.conflicts)+len(b.conflicts) != 0 {
		t.Errorf("conflicts: %v %v", a.conflicts, b.conflicts)
	}
}
