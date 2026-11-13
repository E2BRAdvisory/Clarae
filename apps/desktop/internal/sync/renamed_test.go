package sync

// Rename hints (Engine.Renamed) never wait for a running cycle: they are
// queued and applied by the holder of e.run at its next safe point. These
// tests hold a cycle in its pull (gatedRemote), rename while it waits, and
// check that the hint returns at once and that the outcome is the one of a
// hint applied between two cycles: the identity survives, a rename racing a
// remote modify, move or delete of the same file converges without losing
// either side, and a folder still goes as one move_prefix (ADR-0040).

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/syncproto"
)

// gatedRemote is a folderServer whose next Changes call, once armed, blocks
// until released: a cycle held in the middle of its pull, as a long download
// or bootstrap would hold it.
type gatedRemote struct {
	*folderServer
	gate    stdsync.Mutex
	entered chan struct{}
	release chan struct{}
}

func (g *gatedRemote) arm() (entered, release chan struct{}) {
	g.gate.Lock()
	defer g.gate.Unlock()
	g.entered, g.release = make(chan struct{}), make(chan struct{})
	return g.entered, g.release
}

func (g *gatedRemote) Changes(ctx context.Context, since int64, sinceID string, limit int) (transport.Changes, error) {
	g.gate.Lock()
	entered, release := g.entered, g.release
	g.entered, g.release = nil, nil
	g.gate.Unlock()
	if entered != nil {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return transport.Changes{}, ctx.Err()
		}
	}
	return g.folderServer.Changes(ctx, since, sinceID, limit)
}

// gatedDevices links device A (through the gate) and device B to one server,
// with files already synced on both.
func gatedDevices(t *testing.T, files map[string]string) (g *gatedRemote, a *Engine, adir string, b *Engine, bdir string) {
	t.Helper()
	s := newFolderServer()
	g = &gatedRemote{folderServer: s}
	a, adir = newTestEngine(t, g, 0)
	b, bdir = newTestEngine(t, s, 0)
	for p, c := range files {
		put(t, adir, p, c)
	}
	syncOK(t, a)
	syncOK(t, b)
	return g, a, adir, b, bdir
}

// renameDuringCycle runs a cycle of A held in its pull and, while it waits,
// renames from to to as the Rename binding does: move (the disk change) then
// the hint, which must return without waiting for the cycle. With moveFirst
// the disk change is made before the cycle starts, so its scan already saw it
// (as a delete plus a new file when the content changed too). It returns the
// cycle's error.
func renameDuringCycle(t *testing.T, g *gatedRemote, a *Engine, from, to string, moveFirst bool, move func()) error {
	t.Helper()
	entered, release := g.arm()
	var once stdsync.Once
	open := func() { once.Do(func() { close(release) }) }
	t.Cleanup(open) // a failed test never leaves the cycle hanging
	if moveFirst {
		move()
	}
	cycle := make(chan error, 1)
	go func() { cycle <- a.Sync(context.Background()) }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the cycle never reached its pull")
	}
	if !moveFirst {
		move()
	}
	hint := make(chan error, 1)
	go func() { hint <- a.Renamed(context.Background(), from, to) }()
	select {
	case err := <-hint:
		if err != nil {
			t.Fatalf("rename hint: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Renamed waited for the running cycle")
	}
	open()
	select {
	case err := <-cycle:
		return err
	case <-time.After(30 * time.Second):
		t.Fatal("the cycle did not finish")
		return nil
	}
}

func fileID(t *testing.T, e *Engine, path string) string {
	t.Helper()
	return parked(t, e, path).FileID
}

// noCreateOrDelete fails when the operations sent lost a file identity (a
// rename sent as a delete plus a create).
func noCreateOrDelete(t *testing.T, ops []syncproto.Op) {
	t.Helper()
	if n, m := countOps(ops, syncproto.OpCreate), countOps(ops, syncproto.OpDelete); n != 0 || m != 0 {
		t.Fatalf("sent %d creates and %d deletes (%+v): the identity was lost", n, m, ops)
	}
}

// The hint returns while a cycle is held in its pull and is applied by that
// cycle before its push: one move, sent in the same cycle.
func TestRenamedDoesNotWaitForARunningCycle(t *testing.T) {
	g, a, adir, b, bdir := gatedDevices(t, acme)
	id := fileID(t, a, "other.md")
	mark := g.mark()
	if err := renameDuringCycle(t, g, a, "other.md", "renamed.md", false, func() { mustRename(t, adir, "other.md", "renamed.md") }); err != nil {
		t.Fatalf("cycle: %v", err)
	}
	ops := g.sent(mark)
	if len(ops) != 1 || ops[0].Op != syncproto.OpMove || ops[0].FileID != id || ops[0].Path != "renamed.md" {
		t.Fatalf("sent %+v, want one move of %s to renamed.md", ops, id)
	}
	allSynced(t, a)
	syncOK(t, b)
	if got := diskFiles(t, bdir)["renamed.md"]; got != "# other\n" || exists(bdir, "other.md") {
		t.Fatalf("B: %s", keys(diskFiles(t, bdir)))
	}
}

// The scan of the running cycle saw a renamed and rewritten note (link
// updates) as a deletion plus a new file; the hint, applied before the push,
// merges them back: a move and a modify of the same file, never a delete
// plus a create.
func TestRenamedAfterTheCycleScannedKeepsIdentity(t *testing.T) {
	g, a, adir, b, bdir := gatedDevices(t, acme)
	id := fileID(t, a, "other.md")
	mark := g.mark()
	err := renameDuringCycle(t, g, a, "other.md", "renamed.md", true, func() {
		mustRename(t, adir, "other.md", "renamed.md")
		put(t, adir, "renamed.md", "# other\n[[link updated]]\n")
	})
	if err != nil {
		t.Fatalf("cycle: %v", err)
	}
	syncOK(t, a)
	ops := g.sent(mark)
	noCreateOrDelete(t, ops)
	if countOps(ops, syncproto.OpMove) != 1 || countOps(ops, syncproto.OpModify) != 1 {
		t.Fatalf("sent %+v, want one move and one modify", ops)
	}
	for _, op := range ops {
		if op.FileID != id {
			t.Fatalf("op %+v is not about %s", op, id)
		}
	}
	allSynced(t, a)
	syncOK(t, b)
	if got := diskFiles(t, bdir)["renamed.md"]; got != "# other\n[[link updated]]\n" || exists(bdir, "other.md") {
		t.Fatalf("B: %s, renamed.md %q", keys(diskFiles(t, bdir)), got)
	}
}

// converged checks that both devices hold the same files and that no row is
// left pending.
func converged(t *testing.T, a *Engine, adir string, b *Engine, bdir string) map[string]string {
	t.Helper()
	syncOK(t, a)
	syncOK(t, b)
	syncOK(t, a)
	fa, fb := diskFiles(t, adir), diskFiles(t, bdir)
	if keys(fa) != keys(fb) {
		t.Fatalf("A has %s, B has %s", keys(fa), keys(fb))
	}
	for p, c := range fa {
		if fb[p] != c {
			t.Fatalf("%s: A %q, B %q", p, c, fb[p])
		}
	}
	allSynced(t, a)
	allSynced(t, b)
	return fa
}

// Renamed here while the running cycle brings a modification of the same file
// made elsewhere: the modification lands in the renamed file, which keeps its
// identity, on both devices.
func TestRenamedRacingRemoteModify(t *testing.T) {
	g, a, adir, b, bdir := gatedDevices(t, acme)
	id := fileID(t, a, "other.md")
	put(t, bdir, "other.md", "# other\nedited on B\n")
	syncOK(t, b)
	mark := g.mark()
	if err := renameDuringCycle(t, g, a, "other.md", "renamed.md", false, func() { mustRename(t, adir, "other.md", "renamed.md") }); err != nil {
		t.Fatalf("cycle: %v", err)
	}
	files := converged(t, a, adir, b, bdir)
	if got := files["renamed.md"]; got != "# other\nedited on B\n" {
		t.Fatalf("renamed.md = %q (%s)", got, keys(files))
	}
	if _, ok := files["other.md"]; ok {
		t.Fatalf("the old path came back: %s", keys(files))
	}
	if got := fileID(t, a, "renamed.md"); got != id {
		t.Fatalf("renamed.md has id %s, want %s", got, id)
	}
	noCreateOrDelete(t, g.sent(mark))
	if got := strings.Join(g.paths(), ","); !strings.Contains(got, "renamed.md") || strings.Contains(got, "other.md") {
		t.Fatalf("server %s", got)
	}
}

// Renamed here while the running cycle brings a move of the same file made
// elsewhere: the server's move is applied first, then the local rename (the
// later one) is found by the scan and wins; one file, same identity.
func TestRenamedRacingRemoteMove(t *testing.T) {
	g, a, adir, b, bdir := gatedDevices(t, acme)
	id := fileID(t, a, "other.md")
	mustRename(t, bdir, "other.md", "elsewhere.md")
	syncOK(t, b)
	mark := g.mark()
	if err := renameDuringCycle(t, g, a, "other.md", "renamed.md", false, func() { mustRename(t, adir, "other.md", "renamed.md") }); err != nil {
		t.Fatalf("cycle: %v", err)
	}
	files := converged(t, a, adir, b, bdir)
	if got := keys(files); got != "Acme/plan.md,Acme/sub/notes.md,Acme/sub/pic.png,renamed.md" {
		t.Fatalf("files %s", got)
	}
	if files["renamed.md"] != "# other\n" {
		t.Fatalf("renamed.md = %q", files["renamed.md"])
	}
	if got := fileID(t, a, "renamed.md"); got != id {
		t.Fatalf("renamed.md has id %s, want %s", got, id)
	}
	noCreateOrDelete(t, g.sent(mark))
}

// Renamed here while the running cycle brings the deletion of the same file
// made elsewhere: the file the user still has is never lost, it comes back
// under its new name on both devices.
func TestRenamedRacingRemoteDelete(t *testing.T) {
	g, a, adir, b, bdir := gatedDevices(t, acme)
	if err := os.Remove(filepath.Join(bdir, "other.md")); err != nil {
		t.Fatal(err)
	}
	syncOK(t, b)
	if err := renameDuringCycle(t, g, a, "other.md", "renamed.md", false, func() { mustRename(t, adir, "other.md", "renamed.md") }); err != nil {
		t.Fatalf("cycle: %v", err)
	}
	files := converged(t, a, adir, b, bdir)
	if got := keys(files); got != "Acme/plan.md,Acme/sub/notes.md,Acme/sub/pic.png,renamed.md" {
		t.Fatalf("files %s", got)
	}
	if files["renamed.md"] != "# other\n" {
		t.Fatalf("renamed.md = %q", files["renamed.md"])
	}
}

// A folder renamed from the UI while the running cycle brings an edit made
// elsewhere inside it: the edit lands in the moved file and the folder still
// goes as one move_prefix (ADR-0040), on both devices.
func TestFolderRenamedDuringCycleWithRemoteEdit(t *testing.T) {
	g, a, adir, b, bdir := gatedDevices(t, acme)
	put(t, bdir, "Acme/sub/notes.md", "# notes\nedited on B\n")
	syncOK(t, b)
	mark := g.mark()
	if err := renameDuringCycle(t, g, a, "Acme", "Acme-2024", false, func() { mustRename(t, adir, "Acme", "Acme-2024") }); err != nil {
		t.Fatalf("cycle: %v", err)
	}
	files := converged(t, a, adir, b, bdir)
	if got := keys(files); got != "Acme-2024/plan.md,Acme-2024/sub/notes.md,Acme-2024/sub/pic.png,other.md" {
		t.Fatalf("files %s", got)
	}
	if got := files["Acme-2024/sub/notes.md"]; got != "# notes\nedited on B\n" {
		t.Fatalf("notes = %q", got)
	}
	ops := g.sent(mark)
	if len(ops) != 1 || ops[0].Op != syncproto.OpMovePrefix || ops[0].From != "Acme" || ops[0].To != "Acme-2024" {
		t.Fatalf("sent %+v, want one move_prefix Acme -> Acme-2024", ops)
	}
	if exists(bdir, "Acme") {
		t.Error("B moved the files one by one (the old folder is left behind)")
	}
}

// Hints made while e.run is held and no cycle follows (here from inside
// Exclusive, which used to deadlock) are applied in order when it is released.
func TestRenamedQueuedWhileHeldIsAppliedOnRelease(t *testing.T) {
	ctx := context.Background()
	s := newFolderServer()
	a, adir := newTestEngine(t, s, 0)
	put(t, adir, "other.md", "# other\n")
	syncOK(t, a)
	id := fileID(t, a, "other.md")
	err := a.Exclusive(func() error {
		mustRename(t, adir, "other.md", "b.md")
		if err := a.Renamed(ctx, "other.md", "b.md"); err != nil {
			return err
		}
		mustRename(t, adir, "b.md", "c.md")
		if err := a.Renamed(ctx, "b.md", "c.md"); err != nil {
			return err
		}
		if _, ok, _ := a.cfg.DB.GetFile(ctx, "other.md"); !ok {
			t.Error("a hint was applied while e.run was held by somebody else")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := a.cfg.DB.Files(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Path != "c.md" || rows[0].FileID != id || rows[0].State != StateLocalMoved || rows[0].MovedFrom != "other.md" {
		t.Fatalf("rows %+v, want %s moved from other.md to c.md", rows, id)
	}
	mark := s.mark()
	syncOK(t, a)
	if ops := s.sent(mark); len(ops) != 1 || ops[0].Op != syncproto.OpMove || ops[0].Path != "c.md" {
		t.Fatalf("sent %+v, want one move to c.md", ops)
	}
}

// Many renames while cycles run back to back: no hint is lost or deadlocks,
// every file keeps its identity, and server and disk agree in the end.
func TestRenamedWhileCyclesRun(t *testing.T) {
	ctx := context.Background()
	s := newFolderServer()
	a, adir := newTestEngine(t, s, 0)
	const n = 30
	for i := range n {
		put(t, adir, fmt.Sprintf("n%02d.md", i), fmt.Sprintf("# note %d\n", i))
	}
	syncOK(t, a)
	ids := map[string]string{}
	for i := range n {
		ids[fmt.Sprintf("n%02d.md", i)] = fileID(t, a, fmt.Sprintf("n%02d.md", i))
	}
	stop := make(chan struct{})
	loop := make(chan error, 1)
	go func() {
		for {
			select {
			case <-stop:
				loop <- nil
				return
			default:
			}
			if err := a.Sync(ctx); err != nil {
				loop <- err
				return
			}
		}
	}()
	for i := range n {
		from, to := fmt.Sprintf("n%02d.md", i), fmt.Sprintf("dir/r%02d.md", i)
		mustRename(t, adir, from, to)
		start := time.Now()
		if err := a.Renamed(ctx, from, to); err != nil {
			t.Errorf("hint %s: %v", from, err)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("hint %s took %s", from, d)
		}
	}
	close(stop)
	if err := <-loop; err != nil {
		t.Fatalf("cycle: %v", err)
	}
	syncOK(t, a)
	syncOK(t, a)
	allSynced(t, a)
	for i := range n {
		from, to := fmt.Sprintf("n%02d.md", i), fmt.Sprintf("dir/r%02d.md", i)
		if got := fileID(t, a, to); got != ids[from] {
			t.Errorf("%s has id %s, want %s (from %s)", to, got, ids[from], from)
		}
	}
	if got, want := strings.Join(s.paths(), ","), keys(diskFiles(t, adir)); got != want {
		t.Fatalf("server %s, disk %s", got, want)
	}
}
