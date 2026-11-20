//go:build !js && !windows

package terminal

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// newManager returns a Manager that runs /bin/sh, with the events in the recorder.
func newManager(t *testing.T, mod func(*Options)) (*Manager, *recorder, *fakeWindow) {
	t.Helper()
	rec := newRecorder()
	w := &fakeWindow{}
	o := Options{
		Emit:   rec.emit,
		Window: w,
		Shell:  func() (Spec, error) { return Spec{Path: "/bin/sh"}, nil },
	}
	if mod != nil {
		mod(&o)
	}
	m := NewManager(o)
	t.Cleanup(m.Shutdown)
	return m, rec, w
}

func tempDir(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func pidOf(t *testing.T, m *Manager, id string) int {
	t.Helper()
	s, err := m.get(id)
	if err != nil {
		t.Fatal(err)
	}
	return s.p.(*unixProc).pid
}

// groupGone reports whether no process of the group exists any more.
func groupGone(pgid int) bool {
	err := syscall.Kill(-pgid, 0)
	return errors.Is(err, syscall.ESRCH)
}

func processGone(pid int) bool {
	err := syscall.Kill(pid, 0)
	return errors.Is(err, syscall.ESRCH)
}

var childRe = regexp.MustCompile(`CHILD=(\d+)`)

func TestOpenRunsTheShellInTheDirectory(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	dir := tempDir(t)
	info, err := m.Open("vault-1", dir, 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	if info.Cwd != dir || info.VaultID != "vault-1" || info.Shell != "sh" || info.Title != filepath.Base(dir) || info.ID == "" {
		t.Fatalf("info = %+v", info)
	}
	if err := m.Write(info.ID, "pwd; echo hello-$((1+2)); echo $TERM $COLORTERM $TERM_PROGRAM; stty size\n"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the answer of the shell", func() bool { return strings.Contains(rec.text(info.ID), "40 120") })
	out := rec.text(info.ID)
	for _, want := range []string{dir + "\r\n", "hello-3", "xterm-256color truecolor Clarae"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%q", want, out)
		}
	}
	if list := m.List(); len(list) != 1 || list[0].ID != info.ID {
		t.Errorf("List() = %+v", list)
	}
}

func TestOpenRefusesAMissingDirectory(t *testing.T) {
	m, _, _ := newManager(t, nil)
	if _, err := m.Open("", filepath.Join(tempDir(t), "nope"), 80, 24); !errors.Is(err, ErrStart) {
		t.Fatalf("err = %v, want ErrStart", err)
	}
	if _, err := m.Open("", "", 80, 24); !errors.Is(err, ErrStart) {
		t.Fatalf("empty cwd: err = %v, want ErrStart", err)
	}
	if len(m.List()) != 0 {
		t.Error("a failed Open left a session")
	}
	// The reservation of the slot is given back.
	m2, _, _ := newManager(t, func(o *Options) { o.MaxSessions = 1 })
	for range 3 {
		_, _ = m2.Open("", "/nonexistent-dir", 80, 24)
	}
	if _, err := m2.Open("", tempDir(t), 80, 24); err != nil {
		t.Fatalf("after failed opens: %v", err)
	}
}

func TestResize(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	info, err := m.Open("", tempDir(t), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Resize(info.ID, 101, 33); err != nil {
		t.Fatal(err)
	}
	_ = m.Write(info.ID, "stty size\n")
	eventually(t, "the new size", func() bool { return strings.Contains(rec.text(info.ID), "33 101") })
	if err := m.Resize("nope", 80, 24); !errors.Is(err, ErrNotFound) {
		t.Errorf("Resize of an unknown session: %v", err)
	}
	// 0 and absurd sizes are brought into range, not refused.
	if err := m.Resize(info.ID, 0, 1<<20); err != nil {
		t.Errorf("Resize(0, huge) = %v", err)
	}
}

// The snapshot is what the events said, up to the seq it carries; the events after it have a greater seq.
func TestSnapshotAndSeq(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	info, err := m.Open("", tempDir(t), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	_ = m.Write(info.ID, "echo first-$((6*7))\n")
	eventually(t, "first", func() bool { return strings.Contains(rec.text(info.ID), "first-42") })
	// Let the shell go quiet, so that the snapshot and the events are compared on the same ground.
	time.Sleep(100 * time.Millisecond)
	snap, err := m.Snapshot(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	evs := rec.events(info.ID)
	if snap.Seq == 0 || snap.Seq != evs[len(evs)-1].Seq {
		t.Fatalf("snapshot seq %d, last event %d", snap.Seq, evs[len(evs)-1].Seq)
	}
	if snap.Data != rec.text(info.ID) {
		t.Fatalf("snapshot %q differs from the events %q", snap.Data, rec.text(info.ID))
	}
	_ = m.Write(info.ID, "echo second-$((6*8))\n")
	eventually(t, "second", func() bool { return strings.Contains(rec.text(info.ID), "second-48") })
	for _, e := range rec.events(info.ID) {
		if e.Seq > snap.Seq && strings.Contains(snap.Data, e.Data) && e.Data != "" && len(e.Data) > 8 {
			t.Errorf("event %d, after the snapshot, is already in it", e.Seq)
		}
	}
	snap2, _ := m.Snapshot(info.ID)
	if snap2.Seq <= snap.Seq || !strings.Contains(snap2.Data, "second-48") {
		t.Errorf("second snapshot: seq %d (was %d)", snap2.Seq, snap.Seq)
	}
	if _, err := m.Snapshot("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Snapshot of an unknown session: %v", err)
	}
}

// A lot of output is coalesced: far fewer events than lines, none larger than FlushBytes.
func TestOutputIsCoalesced(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	info, err := m.Open("", tempDir(t), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	_ = m.Write(info.ID, "i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done; echo DONE-$((1+1))\n")
	eventually(t, "the loop", func() bool { return strings.Contains(rec.text(info.ID), "DONE-2") })
	evs := rec.events(info.ID)
	if len(evs) > 1500 {
		t.Errorf("%d events for 3000 lines: the output is not coalesced", len(evs))
	}
	for i, e := range evs {
		if len(e.Data) > FlushBytes {
			t.Errorf("event %d has %d bytes", i, len(e.Data))
		}
		if e.Seq != uint64(i+1) {
			t.Errorf("event %d has seq %d", i, e.Seq)
			break
		}
	}
}

func TestCloseEndsTheProcessGroup(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	info, err := m.Open("", tempDir(t), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	pid := pidOf(t, m, info.ID)
	_ = m.Write(info.ID, "sleep 300 & echo CHILD=$!\n")
	eventually(t, "the child", func() bool { return childRe.MatchString(rec.text(info.ID)) })
	child, _ := strconv.Atoi(childRe.FindStringSubmatch(rec.text(info.ID))[1])

	start := time.Now()
	if err := m.Close(info.ID); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("Close took %v", d)
	}
	if !groupGone(pid) {
		t.Error("the process group of the shell still exists after Close")
	}
	eventually(t, "the child to go", func() bool { return processGone(child) })
	if len(m.List()) != 0 {
		t.Error("the session is still listed")
	}
	exits := rec.exitsOf()
	if len(exits) != 1 || exits[0].ID != info.ID || exits[0].Reason != ReasonClosed {
		t.Errorf("exit events = %+v", exits)
	}
	if err := m.Close(info.ID); err != nil { // already gone: not an error
		t.Errorf("second Close = %v", err)
	}
}

// A job that ignores SIGHUP, in a shell that ignores it too, is killed after KillAfter: nothing
// outlives the tab.
func TestCloseKillsWhatIgnoresHangup(t *testing.T) {
	m, rec, _ := newManager(t, func(o *Options) { o.KillAfter = 400 * time.Millisecond })
	info, err := m.Open("", tempDir(t), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	pid := pidOf(t, m, info.ID)
	_ = m.Write(info.ID, "trap '' HUP; nohup sleep 300 >/dev/null 2>&1 & echo CHILD=$!\n")
	eventually(t, "the child", func() bool { return childRe.MatchString(rec.text(info.ID)) })
	child, _ := strconv.Atoi(childRe.FindStringSubmatch(rec.text(info.ID))[1])
	// Let the shell run the trap before the hang-up comes.
	time.Sleep(100 * time.Millisecond)

	start := time.Now()
	if err := m.Close(info.ID); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 300*time.Millisecond || d > 3*time.Second {
		t.Errorf("Close took %v: it should wait KillAfter (400ms) for the hang-up and then kill", d)
	}
	if !groupGone(pid) {
		t.Error("the process group survived")
	}
	eventually(t, "the background job to go", func() bool { return processGone(child) })
}

// The shell ends by itself: the session ends with its status and leaves nothing behind.
func TestTheShellExitsByItself(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	info, err := m.Open("", tempDir(t), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	pid := pidOf(t, m, info.ID)
	_ = m.Write(info.ID, "nohup sleep 300 >/dev/null 2>&1 & echo CHILD=$!\n")
	eventually(t, "the child", func() bool { return childRe.MatchString(rec.text(info.ID)) })
	_ = m.Write(info.ID, "exit 3\n")
	eventually(t, "the exit event", func() bool { return len(rec.exitsOf()) == 1 })
	e := rec.exitsOf()[0]
	if e.ID != info.ID || e.Code != 3 || e.Reason != ReasonExited {
		t.Errorf("exit = %+v", e)
	}
	child, _ := strconv.Atoi(childRe.FindStringSubmatch(rec.text(info.ID))[1])
	if !groupGone(pid) {
		t.Error("the group survived the exit of the shell")
	}
	eventually(t, "the background job to go", func() bool { return processGone(child) })
	if len(m.List()) != 0 {
		t.Error("an ended session is still listed")
	}
	if err := m.Write(info.ID, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Write to an ended session: %v", err)
	}
}

func TestSessionLimit(t *testing.T) {
	m, _, _ := newManager(t, func(o *Options) { o.MaxSessions = 2 })
	dir := tempDir(t)
	a, err := m.Open("", dir, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Open("", dir, 80, 24); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Open("", dir, 80, 24); !errors.Is(err, ErrLimit) {
		t.Fatalf("third session: %v, want ErrLimit", err)
	}
	_ = m.Close(a.ID)
	if _, err := m.Open("", dir, 80, 24); err != nil {
		t.Fatalf("after closing one: %v", err)
	}
}

func TestWriteLimits(t *testing.T) {
	m, _, _ := newManager(t, nil)
	if err := m.Write("nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown session: %v", err)
	}
	info, _ := m.Open("", tempDir(t), 80, 24)
	if err := m.Write(info.ID, strings.Repeat("x", MaxWrite+1)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("a paste over the limit: %v", err)
	}
	if err := m.Write(info.ID, ""); err != nil {
		t.Errorf("empty write: %v", err)
	}
}

func TestShutdownIsQuickAndEndsEverything(t *testing.T) {
	m, rec, _ := newManager(t, nil) // KillAfter at its default: 1 s
	dir := tempDir(t)
	var pids []int
	var children []int
	for range 4 {
		info, err := m.Open("", dir, 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		pids = append(pids, pidOf(t, m, info.ID))
		_ = m.Write(info.ID, "trap '' HUP; nohup sleep 300 >/dev/null 2>&1 & echo CHILD=$!\n")
		eventually(t, "a child", func() bool { return childRe.MatchString(rec.text(info.ID)) })
		c, _ := strconv.Atoi(childRe.FindStringSubmatch(rec.text(info.ID))[1])
		children = append(children, c)
	}
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	m.Shutdown()
	if d := time.Since(start); d > 2500*time.Millisecond {
		t.Errorf("Shutdown took %v: it has 3 s, watchdog included", d)
	}
	for _, pid := range pids {
		if !groupGone(pid) {
			t.Errorf("group %d survived Shutdown", pid)
		}
	}
	for _, c := range children {
		cc := c
		eventually(t, "a background job to go", func() bool { return processGone(cc) })
	}
	if len(m.List()) != 0 {
		t.Error("sessions are listed after Shutdown")
	}
	if n := len(rec.exitsOf()); n != 0 {
		t.Errorf("Shutdown sent %d exit events: nobody listens", n)
	}
	if _, err := m.Open("", dir, 80, 24); !errors.Is(err, ErrShutdown) {
		t.Errorf("Open after Shutdown: %v", err)
	}
	m.Shutdown() // idempotent
}

// Opening, using and closing sessions leaves no goroutine and no descriptor behind.
func TestNoGoroutineLeak(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	dir := tempDir(t)
	// One round first: the runtime and the pty package start what they keep.
	warm, err := m.Open("", dir, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	_ = m.Close(warm.ID)
	before := runtime.NumGoroutine()
	fds := openFDs(t)
	for range 5 {
		info, err := m.Open("", dir, 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		_ = m.Write(info.ID, "echo hi\n")
		eventually(t, "output", func() bool { return strings.Contains(rec.text(info.ID), "hi") })
		_ = m.Close(info.ID)
	}
	eventually(t, "the goroutines to end", func() bool { return runtime.NumGoroutine() <= before })
	if n := openFDs(t); n > fds {
		t.Errorf("%d descriptors open, %d before", n, fds)
	}
}

func openFDs(t *testing.T) int {
	t.Helper()
	for _, dir := range []string{"/dev/fd", "/proc/self/fd"} {
		if es, err := os.ReadDir(dir); err == nil {
			return len(es)
		}
	}
	t.Skip("no way to count the open descriptors")
	return 0
}

func TestCloseVaultAndWindowClose(t *testing.T) {
	m, rec, w := newManager(t, nil)
	dir := tempDir(t)
	a, _ := m.Open("v1", dir, 80, 24)
	b, _ := m.Open("v2", dir, 80, 24)
	c, _ := m.Open("v1", dir, 80, 24)

	if n := m.CloseVault("v1", ReasonReadOnly); n != 2 {
		t.Fatalf("CloseVault closed %d sessions, want 2", n)
	}
	var gone []string
	for _, e := range rec.exitsOf() {
		if e.Reason != ReasonReadOnly {
			t.Errorf("exit %+v: reason should be read-only", e)
		}
		gone = append(gone, e.ID)
	}
	if len(gone) != 2 || !contains(gone, a.ID) || !contains(gone, c.ID) {
		t.Errorf("sessions ended: %v, want %s and %s", gone, a.ID, c.ID)
	}
	if list := m.List(); len(list) != 1 || list[0].ID != b.ID {
		t.Errorf("List after CloseVault = %+v", list)
	}

	// Undock keeps the sessions; the system closing the window ends them and docks the panel.
	if err := m.Undock(); err != nil {
		t.Fatal(err)
	}
	if len(m.List()) != 1 {
		t.Fatal("Undock changed the sessions")
	}
	m.WindowClosedBySystem()
	if len(m.List()) != 0 || m.State() != ModeDocked {
		t.Errorf("after the window was closed: sessions %d, state %q", len(m.List()), m.State())
	}
	last := rec.exitsOf()
	if e := last[len(last)-1]; e.ID != b.ID || e.Reason != ReasonWindowClosed {
		t.Errorf("last exit = %+v", e)
	}
	if got := rec.layouts(); got[len(got)-1] != ModeDocked {
		t.Errorf("layout events %v", got)
	}
	if _, closes := w.counts(); closes != 0 {
		t.Error("the window the user closed was closed again by the manager")
	}
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// Undock and Dock do not touch the shells: the one that was running goes on and keeps its history.
func TestUndockDockKeepTheSessions(t *testing.T) {
	m, rec, _ := newManager(t, nil)
	info, _ := m.Open("", tempDir(t), 80, 24)
	_ = m.Write(info.ID, "X=kept\n")
	if err := m.Undock(); err != nil {
		t.Fatal(err)
	}
	if err := m.Dock(); err != nil {
		t.Fatal(err)
	}
	_ = m.Write(info.ID, "echo value-$X\n")
	eventually(t, "the variable", func() bool { return strings.Contains(rec.text(info.ID), "value-kept") })
}

func TestDefaultShell(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	spec, err := defaultShell()
	if err != nil || spec.Path != "/bin/sh" || len(spec.Args) != 1 || spec.Args[0] != "-l" {
		t.Fatalf("defaultShell() = %+v, %v", spec, err)
	}
	// A $SHELL that is not an absolute path to an executable file is ignored.
	for _, bad := range []string{"", "sh", "/does/not/exist", t.TempDir()} {
		t.Setenv("SHELL", bad)
		spec, err := defaultShell()
		if err != nil || spec.Path == bad && bad != "" {
			t.Errorf("SHELL=%q: %+v, %v", bad, spec, err)
		}
	}
}

func TestMergeEnv(t *testing.T) {
	got := mergeEnv([]string{"A=1", "TERM=dumb", "PWD=/old", "B=2"}, map[string]string{"TERM": "xterm-256color", "PWD": "/new"})
	want := map[string]string{"A": "1", "B": "2", "TERM": "xterm-256color", "PWD": "/new"}
	if len(got) != len(want) {
		t.Fatalf("env = %v", got)
	}
	for _, kv := range got {
		k, v, _ := strings.Cut(kv, "=")
		if want[k] != v {
			t.Errorf("env %s=%q, want %q", k, v, want[k])
		}
	}
}
