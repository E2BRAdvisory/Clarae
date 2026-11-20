//go:build !js

package terminal

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/events"
)

// Limits and timings (Options leaves each overridable for tests).
const (
	// MaxSessions is the number of sessions the core keeps at once.
	MaxSessions = 16
	// RingSize is the output kept per session for Snapshot.
	RingSize = 2 << 20
	// FlushDelay and FlushBytes coalesce the output into events.
	FlushDelay = 16 * time.Millisecond
	FlushBytes = 32 << 10
	// KillAfter is how long a closing session may take to go after SIGHUP before it is killed.
	KillAfter = time.Second
	// MaxWrite is the largest input accepted in one Write (a paste); larger is refused, not cut.
	MaxWrite = 1 << 20
	// DefaultCols and DefaultRows are used when the UI has not measured the panel yet.
	DefaultCols, DefaultRows = 80, 24
	maxCols, maxRows         = 1000, 1000
	// drainGrace is how long the output of a shell that ended is read before the pty is closed.
	drainGrace = 300 * time.Millisecond
)

// The errors of the Manager. The binding gives each its code.
var (
	// ErrNotFound: no such session (never opened, or ended).
	ErrNotFound = errors.New("terminal: no such session")
	// ErrLimit: MaxSessions are open.
	ErrLimit = errors.New("terminal: too many sessions")
	// ErrShutdown: the application is quitting.
	ErrShutdown = errors.New("terminal: the application is quitting")
	// ErrBusy: the shell is not reading its input.
	ErrBusy = errors.New("terminal: the session does not take input")
	// ErrTooLarge: a Write larger than MaxWrite.
	ErrTooLarge = errors.New("terminal: input too large")
	// ErrStart: the shell could not be started; the cause is wrapped.
	ErrStart = errors.New("terminal: cannot start the shell")
)

// Spec is the program of a session.
type Spec struct {
	Path string
	Args []string
}

// Window is the separate window of the terminal, which the host opens and closes (internal/shell).
// Open shows it (creating it the first time, bringing it forward if it exists); Close destroys it
// without telling the Manager that the user did it.
type Window interface {
	Open() error
	Close()
}

// Options configure a Manager. The zero value of every field but Emit means the default.
type Options struct {
	// Emit delivers the events (App.emit).
	Emit events.Emitter
	// Window is the separate window; nil = none (Undock fails).
	Window Window
	Logger zerolog.Logger
	// Shell returns the program to run; nil = the shell of the user (shell_unix.go, shell_windows.go).
	Shell func() (Spec, error)
	// Home returns the directory used when a session has none; nil = the home of the user.
	Home func() (string, error)

	MaxSessions int
	RingSize    int
	FlushDelay  time.Duration
	FlushBytes  int
	KillAfter   time.Duration
}

// Info describes a session.
type Info struct {
	ID string
	// VaultID is the vault whose root is the directory of the session ("" for the home directory).
	VaultID string
	Cwd     string
	// Shell is the name of the shell program ("zsh", "pwsh.exe").
	Shell string
	// Title is the initial title of the tab: the name of the directory.
	Title string
}

// Snapshot is what a session has shown so far.
type Snapshot struct {
	// Data is the retained output (at most RingSize bytes), as the events delivered it.
	Data string
	// Seq is the seq of the last event Data contains: ignore terminal:output events up to it.
	Seq uint64
}

// Manager owns the sessions and the place of the panel. It is safe for concurrent use.
type Manager struct {
	opt Options

	mu       sync.Mutex
	sessions map[string]*session
	starting int
	shutdown bool
	counter  int // creation order, for List

	// modeMu serializes Undock, Dock and WindowClosedBySystem; mode is guarded by mu.
	modeMu sync.Mutex
	mode   Mode
}

// NewManager returns a Manager with no sessions, docked.
func NewManager(o Options) *Manager {
	if o.MaxSessions <= 0 {
		o.MaxSessions = MaxSessions
	}
	if o.RingSize <= 0 {
		o.RingSize = RingSize
	}
	if o.FlushDelay <= 0 {
		o.FlushDelay = FlushDelay
	}
	if o.FlushBytes <= 0 {
		o.FlushBytes = FlushBytes
	}
	if o.KillAfter <= 0 {
		o.KillAfter = KillAfter
	}
	if o.Shell == nil {
		o.Shell = defaultShell
	}
	if o.Home == nil {
		o.Home = os.UserHomeDir
	}
	return &Manager{opt: o, sessions: map[string]*session{}, mode: ModeDocked}
}

// Home returns the directory a session without a vault starts in.
func (m *Manager) Home() (string, error) { return m.opt.Home() }

// Open starts a shell in cwd, which must be an existing directory the caller has already chosen
// (the binding resolves it from an open vault; this package does not judge it), at the given size.
func (m *Manager) Open(vaultID, cwd string, cols, rows int) (Info, error) {
	cols, rows = clampSize(cols, rows)
	m.mu.Lock()
	if m.shutdown {
		m.mu.Unlock()
		return Info{}, ErrShutdown
	}
	if len(m.sessions)+m.starting >= m.opt.MaxSessions {
		m.mu.Unlock()
		return Info{}, ErrLimit
	}
	m.starting++
	m.mu.Unlock()
	started := false
	defer func() {
		if !started {
			m.mu.Lock()
			m.starting--
			m.mu.Unlock()
		}
	}()

	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return Info{}, fmt.Errorf("%w: the directory is not there", ErrStart)
	}
	spec, err := m.opt.Shell()
	if err != nil {
		return Info{}, fmt.Errorf("%w: %w", ErrStart, err)
	}
	p, err := startProc(spec, cwd, sessionEnv(cwd), cols, rows)
	if err != nil {
		return Info{}, fmt.Errorf("%w: %w", ErrStart, err)
	}
	s := &session{
		m:          m,
		p:          p,
		info:       Info{ID: uuid.NewString(), VaultID: vaultID, Cwd: cwd, Shell: filepath.Base(spec.Path), Title: titleOf(cwd)},
		ring:       newRing(m.opt.RingSize),
		in:         make(chan []byte, 64),
		stop:       make(chan struct{}),
		readerDone: make(chan struct{}),
		done:       make(chan struct{}),
	}
	m.mu.Lock()
	m.starting--
	started = true
	if m.shutdown {
		m.mu.Unlock()
		s.setReason(ReasonClosed)
		s.quiet.Store(true)
		go s.terminate()
		go s.run()
		return Info{}, ErrShutdown
	}
	m.counter++
	s.order = m.counter
	m.sessions[s.info.ID] = s
	m.mu.Unlock()
	go s.run()
	return s.info, nil
}

// List returns the sessions, oldest first.
func (m *Manager) List() []Info {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	sortByOrder(all)
	out := make([]Info, len(all))
	for i, s := range all {
		out[i] = s.info
	}
	return out
}

func (m *Manager) get(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return s, nil
}

// Write sends keystrokes to the shell. It never blocks on the shell: a session that does not take
// its input (a full buffer) answers ErrBusy.
func (m *Manager) Write(id, data string) error {
	if len(data) > MaxWrite {
		return ErrTooLarge
	}
	s, err := m.get(id)
	if err != nil {
		return err
	}
	if data == "" {
		return nil
	}
	select {
	case s.in <- []byte(data):
		return nil
	case <-s.done:
		return ErrNotFound
	default:
		return ErrBusy
	}
}

// Resize tells the pseudo-terminal the size of the panel.
func (m *Manager) Resize(id string, cols, rows int) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	cols, rows = clampSize(cols, rows)
	return s.p.Resize(cols, rows)
}

// Snapshot returns what the session has shown (see Snapshot).
func (m *Manager) Snapshot(id string) (Snapshot, error) {
	s, err := m.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return Snapshot{Data: s.ring.text(), Seq: s.seq}, nil
}

// Close ends a session (SIGHUP, then SIGKILL after KillAfter) and returns when the shell and
// whatever it started in its group are gone. A session already gone is not an error.
func (m *Manager) Close(id string) error {
	s, err := m.get(id)
	if err != nil {
		return nil
	}
	m.closeAll([]*session{s}, ReasonClosed, false)
	return nil
}

// CloseVault ends the sessions of a vault (it became read-only) with the reason, and returns how many.
func (m *Manager) CloseVault(vaultID string, reason ExitReason) int {
	m.mu.Lock()
	var list []*session
	for _, s := range m.sessions {
		if s.info.VaultID == vaultID {
			list = append(list, s)
		}
	}
	m.mu.Unlock()
	m.closeAll(list, reason, false)
	return len(list)
}

// CloseAll ends every session.
func (m *Manager) CloseAll(reason ExitReason) { m.closeAll(m.all(), reason, false) }

func (m *Manager) all() []*session {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	return list
}

// closeAll ends the sessions in parallel and waits for them. quiet drops terminal:exit (the
// application is quitting and nobody listens).
func (m *Manager) closeAll(list []*session, reason ExitReason, quiet bool) {
	var wg sync.WaitGroup
	for _, s := range list {
		s.setReason(reason)
		if quiet {
			s.quiet.Store(true)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.terminate()
			<-s.done
		}()
	}
	wg.Wait()
}

// Shutdown ends every session and refuses new ones, returning within about KillAfter plus a small
// margin whatever the processes do: it must fit the watchdog of the quit (shell.QuitWatchdog).
// It is idempotent.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.shutdown = true
	list := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	finished := make(chan struct{})
	go func() {
		m.closeAll(list, ReasonClosed, true)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(m.opt.KillAfter + 1500*time.Millisecond):
		m.opt.Logger.Warn().Msg("terminal: some sessions did not end in time at shutdown")
	}
}

// State returns where the panel is shown.
func (m *Manager) State() Mode {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mode
}

func (m *Manager) setMode(mode Mode) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.mode == mode {
		return false
	}
	m.mode = mode
	return true
}

// Undock moves the panel to the separate window, opening it (or bringing it forward). The sessions
// go on: nothing is restarted.
func (m *Manager) Undock() error {
	m.modeMu.Lock()
	defer m.modeMu.Unlock()
	if m.opt.Window == nil {
		return errors.New("terminal: no window to undock to")
	}
	if m.isShutdown() {
		return ErrShutdown
	}
	// The state is detached, and said so, before the window exists: the page of the window asks State
	// when it starts, and must not read docked.
	changed := m.setMode(ModeDetached)
	if changed {
		EventLayout.Send(m.opt.Emit, LayoutPayload{Mode: ModeDetached})
	}
	if err := m.opt.Window.Open(); err != nil {
		if changed { // the window did not come: the panel is where it was
			m.setMode(ModeDocked)
			EventLayout.Send(m.opt.Emit, LayoutPayload{Mode: ModeDocked})
		}
		return err
	}
	return nil
}

// Dock closes the separate window and moves the panel back to the main one. The sessions go on.
func (m *Manager) Dock() error {
	m.modeMu.Lock()
	defer m.modeMu.Unlock()
	if m.State() == ModeDocked {
		return nil
	}
	if m.opt.Window != nil {
		m.opt.Window.Close()
	}
	if m.setMode(ModeDocked) {
		EventLayout.Send(m.opt.Emit, LayoutPayload{Mode: ModeDocked})
	}
	return nil
}

// WindowClosedBySystem is called by the host when the user closed the separate window with the
// button of the system: what lived in it ends (every session), and the panel is docked, closed.
// It does nothing when the panel is not detached (a late call for a window Dock closed).
func (m *Manager) WindowClosedBySystem() {
	m.modeMu.Lock()
	defer m.modeMu.Unlock()
	if m.State() != ModeDetached {
		return
	}
	m.setMode(ModeDocked)
	m.closeAll(m.all(), ReasonWindowClosed, false)
	EventLayout.Send(m.opt.Emit, LayoutPayload{Mode: ModeDocked})
}

func (m *Manager) isShutdown() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.shutdown
}

func (m *Manager) remove(s *session) {
	m.mu.Lock()
	delete(m.sessions, s.info.ID)
	m.mu.Unlock()
}

func clampSize(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = DefaultCols
	}
	if rows <= 0 {
		rows = DefaultRows
	}
	return min(cols, maxCols), min(rows, maxRows)
}

func titleOf(cwd string) string {
	if b := filepath.Base(cwd); b != "" && b != "." && b != string(filepath.Separator) {
		return b
	}
	return cwd
}

// sessionEnv is the environment of a shell: the one of the application, plus what a terminal
// emulator tells its programs.
func sessionEnv(cwd string) []string {
	return mergeEnv(os.Environ(), map[string]string{
		"TERM":         "xterm-256color",
		"COLORTERM":    "truecolor",
		"TERM_PROGRAM": "Clarae",
		"PWD":          cwd,
	})
}

// mergeEnv returns env with the given variables set (case-insensitively on Windows, where names are).
func mergeEnv(env []string, set map[string]string) []string {
	out := make([]string, 0, len(env)+len(set))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		if name == "" && strings.HasPrefix(kv, "=") { // Windows: "=C:=C:\dir"
			out = append(out, kv)
			continue
		}
		drop := false
		for k := range set {
			if envNameEqual(name, k) {
				drop = true
				break
			}
		}
		if !drop && !strings.ContainsRune(kv, 0) {
			out = append(out, kv)
		}
	}
	for k, v := range set {
		out = append(out, k+"="+v)
	}
	return out
}

// session is one shell on one pseudo-terminal.
type session struct {
	m     *Manager
	p     proc
	info  Info
	order int

	reasonMu sync.Mutex
	reason   ExitReason  // why it ended; the first one set wins
	quiet    atomic.Bool // no terminal:exit

	// emitMu orders the events of the session; mu guards what follows.
	emitMu  sync.Mutex
	mu      sync.Mutex
	pending []byte
	timer   *time.Timer
	ring    *ring
	seq     uint64

	in         chan []byte   // keystrokes, written by the writer goroutine
	stop       chan struct{} // closed when the session is over: the writer stops
	readerDone chan struct{}
	done       chan struct{} // closed when the session is over, exit event sent
	termOnce   sync.Once
}

// run is the life of the session: it reads, writes, and waits for the shell.
func (s *session) run() {
	go s.reader()
	go s.writer()
	code := s.p.Wait()
	// What the shell left in its process group goes with it (a job it started in the background).
	s.terminate()
	select {
	case <-s.readerDone:
	case <-time.After(drainGrace):
	}
	_ = s.p.Close() // wakes a reader that still waits
	select {
	case <-s.readerDone:
	case <-time.After(2 * time.Second):
		s.m.opt.Logger.Warn().Str("session", s.info.ID).Msg("terminal: the reader did not stop")
	}
	close(s.stop)
	s.flush(true)
	s.m.remove(s)
	if !s.quiet.Load() {
		EventExit.Send(s.m.opt.Emit, ExitPayload{ID: s.info.ID, Code: code, Reason: s.exitReason()})
	}
	close(s.done)
}

// setReason records why the session ends, unless something already did.
func (s *session) setReason(r ExitReason) {
	s.reasonMu.Lock()
	if s.reason == "" {
		s.reason = r
	}
	s.reasonMu.Unlock()
}

func (s *session) exitReason() ExitReason {
	s.reasonMu.Lock()
	defer s.reasonMu.Unlock()
	if s.reason == "" {
		return ReasonExited
	}
	return s.reason
}

func (s *session) reader() {
	defer close(s.readerDone)
	buf := make([]byte, 32<<10)
	for {
		n, err := s.p.Read(buf)
		if n > 0 {
			s.feed(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func (s *session) writer() {
	for {
		select {
		case b := <-s.in:
			if _, err := s.p.Write(b); err != nil {
				return
			}
		case <-s.stop:
			return
		}
	}
}

// feed adds output and flushes it now when enough waits, or soon.
func (s *session) feed(b []byte) {
	s.mu.Lock()
	s.pending = append(s.pending, b...)
	full := len(s.pending) >= s.m.opt.FlushBytes
	if !full && s.timer == nil {
		s.timer = time.AfterFunc(s.m.opt.FlushDelay, func() { s.flush(false) })
	}
	s.mu.Unlock()
	for full {
		full = s.flushChunk(false)
	}
}

// flush sends everything that waits (final: also an incomplete sequence at the end).
func (s *session) flush(final bool) {
	for s.flushChunk(final) {
	}
}

// flushChunk sends one event of at most FlushBytes and reports whether at least FlushBytes still wait.
func (s *session) flushChunk(final bool) (more bool) {
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	cut := len(s.pending)
	if cut > s.m.opt.FlushBytes {
		cut = s.m.opt.FlushBytes
	}
	if !final || cut < len(s.pending) {
		cut = completePrefix(s.pending[:cut])
	}
	if cut == 0 {
		s.mu.Unlock()
		return false
	}
	chunk := strings.ToValidUTF8(string(s.pending[:cut]), "\uFFFD")
	s.pending = append(s.pending[:0], s.pending[cut:]...)
	s.seq++
	seq := s.seq
	s.ring.write([]byte(chunk))
	more = len(s.pending) >= s.m.opt.FlushBytes
	if !more && len(s.pending) > 0 && s.timer == nil && !final {
		// Held back: the rest of a sequence comes with the next read, or this timer sends it as it is.
		s.timer = time.AfterFunc(4*s.m.opt.FlushDelay, func() { s.flush(true) })
	}
	s.mu.Unlock()
	EventOutput.Send(s.m.opt.Emit, OutputPayload{ID: s.info.ID, Seq: seq, Data: chunk})
	return more
}

// completePrefix returns how much of b can be sent now: all of it, except the bytes of a multibyte
// sequence that the end of b cuts.
func completePrefix(b []byte) int {
	for i := len(b) - 1; i >= 0 && i >= len(b)-(utf8.UTFMax-1); i-- {
		c := b[i]
		if c < utf8.RuneSelf {
			return len(b)
		}
		if utf8.RuneStart(c) {
			if utf8.FullRune(b[i:]) {
				return len(b)
			}
			return i
		}
	}
	return len(b)
}

// terminate ends the process group: hang up, give it KillAfter to go, kill. It returns when the
// group is gone. Safe to call more than once and concurrently.
func (s *session) terminate() {
	s.termOnce.Do(func() {
		s.p.Hangup()
		deadline := time.Now().Add(s.m.opt.KillAfter)
		for s.p.Alive() && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if s.p.Alive() {
			s.p.Kill()
			for i := 0; i < 100 && s.p.Alive(); i++ {
				time.Sleep(10 * time.Millisecond)
			}
		}
	})
}

func sortByOrder(l []*session) {
	sort.Slice(l, func(i, j int) bool { return l[i].order < l[j].order })
}
