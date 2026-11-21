package presence

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/events"
	"clarae/apps/desktop/internal/sync/transport"
)

// Options configure a Hub. Zero durations take the production values.
type Options struct {
	// Client returns the API client of the session, nil when signed out. A different client than
	// before means another login (account or server): the connection is rebuilt.
	Client func() *transport.Client
	// UserID is the account of the session: its other devices are not "other users".
	UserID func() string
	// Enabled is features.presence of the configuration in force.
	Enabled func() bool
	// Resolve maps a file of a local vault to its room (see sync.Manager.PresenceTarget); reason is
	// "" when there is one.
	Resolve func(ctx context.Context, vaultID, path string) (cloudVault, fileID, reason string)
	Emit    events.Emitter
	Log     zerolog.Logger

	Linger      time.Duration // the connection stays open this long after the last room (30 s)
	Throttle    time.Duration // between two move frames (40 ms: 25 per second, under the 40 of the server)
	MoveFlush   time.Duration // coalescence of the move events to the UI (40 ms)
	Ping        time.Duration // application keep-alive (25 s; the server also pings every 30 s and waits 20 s for the pong)
	BackoffBase time.Duration // first reconnection delay (1 s)
	BackoffMax  time.Duration // (60 s)
}

func (o *Options) defaults() {
	set := func(d *time.Duration, v time.Duration) {
		if *d == 0 {
			*d = v
		}
	}
	set(&o.Linger, 30*time.Second)
	set(&o.Throttle, 40*time.Millisecond)
	set(&o.MoveFlush, 40*time.Millisecond)
	set(&o.Ping, 25*time.Second)
	set(&o.BackoffBase, time.Second)
	set(&o.BackoffMax, time.Minute)
	if o.Emit == nil {
		o.Emit = func(string, any) {}
	}
	if o.Enabled == nil {
		o.Enabled = func() bool { return true }
	}
	if o.UserID == nil {
		o.UserID = func() string { return "" }
	}
}

type wkey struct{ vault, path string }

// watch is a file the UI watches; refs counts the panels that do. room is the zero value while the
// file cannot be resolved (suspended: no join, Refresh tries again).
type watch struct {
	refs int
	room transport.PresenceRoom
}

func (w *watch) active() bool { return w.room != transport.PresenceRoom{} }

// session is one connection to the server.
type session struct {
	client  *transport.Client
	cancel  context.CancelFunc
	wake    chan struct{}
	sid     string
	ready   bool
	joined  map[transport.PresenceRoom]bool
	members map[transport.PresenceRoom]map[string]Member
	moves   map[moveKey]Pos // not yet sent to the UI
	flush   *time.Timer
}

type moveKey struct {
	room transport.PresenceRoom
	sid  string
}

// Hub keeps the presence connection of the account and the files the UI watches.
type Hub struct {
	o Options

	refreshMu sync.Mutex // one Refresh at a time: the last to start wins
	mu        sync.Mutex
	watches   map[wkey]*watch
	rooms     map[transport.PresenceRoom]int // active watches per room
	pending   map[transport.PresenceRoom]Pos // to send (latest wins)
	lastPos   map[transport.PresenceRoom]Pos // last one asked for: the same is not sent again
	lastMove  time.Time
	cur       *session
	linger    *time.Timer
	disabled  bool // the server said presence-disabled
	// suspended is the client for which the server said user-suspended: nothing until another login.
	suspended *transport.Client
	// blocked rooms were refused by the server (forbidden, not-found…): not joined again until Refresh.
	blocked map[transport.PresenceRoom]bool
	closed  bool
	root    context.Context
	stopAll context.CancelFunc
}

// NewHub creates a hub; nothing is connected until a file is watched.
func NewHub(o Options) *Hub {
	o.defaults()
	root, stop := context.WithCancel(context.Background())
	return &Hub{
		o: o, watches: map[wkey]*watch{}, rooms: map[transport.PresenceRoom]int{},
		blocked: map[transport.PresenceRoom]bool{}, pending: map[transport.PresenceRoom]Pos{}, lastPos: map[transport.PresenceRoom]Pos{},
		root: root, stopAll: stop,
	}
}

// Close stops the connection and forgets every watch.
func (h *Hub) Close() {
	h.mu.Lock()
	h.closed = true
	h.stopAll()
	evs := h.dropSession()
	h.watches = map[wkey]*watch{}
	h.rooms = map[transport.PresenceRoom]int{}
	if h.linger != nil {
		h.linger.Stop()
		h.linger = nil
	}
	h.mu.Unlock()
	run(evs)
}

func run(evs []func()) {
	for _, e := range evs {
		e()
	}
}

// Watch starts following a file of a vault. Calls for the same file count: Unwatch must be called as
// many times. A file that cannot be followed is not registered, and the reason says why.
func (h *Hub) Watch(ctx context.Context, vaultID, path string) Watching {
	enabled := h.o.Enabled()
	c := h.o.Client()
	if !enabled || h.serverDisabled(c) {
		return Watching{Reason: ReasonDisabled}
	}
	if c == nil {
		return Watching{Reason: ReasonOffline}
	}
	var room transport.PresenceRoom
	h.mu.Lock()
	k := wkey{vaultID, path}
	if w := h.watches[k]; w != nil {
		w.refs++
		evs := h.afterChange(c, enabled, k)
		h.mu.Unlock()
		run(evs)
		return Watching{Watching: true}
	}
	h.mu.Unlock()
	cloud, file, reason := h.o.Resolve(ctx, vaultID, path)
	if reason != "" {
		return Watching{Reason: reason}
	}
	room = transport.PresenceRoom{Vault: cloud, File: file}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return Watching{Reason: ReasonDisabled}
	}
	if w := h.watches[k]; w != nil { // another call got there first
		w.refs++
	} else {
		h.watches[k] = &watch{refs: 1, room: room}
		h.rooms[room]++
	}
	evs := h.afterChange(c, enabled, k)
	h.mu.Unlock()
	run(evs)
	return Watching{Watching: true}
}

// Unwatch undoes one Watch.
func (h *Hub) Unwatch(vaultID, path string) {
	k := wkey{vaultID, path}
	c, enabled := h.o.Client(), h.o.Enabled()
	h.mu.Lock()
	w := h.watches[k]
	if w == nil {
		h.mu.Unlock()
		return
	}
	if w.refs--; w.refs <= 0 {
		delete(h.watches, k)
		h.release(w)
	}
	evs := h.afterChange(c, enabled, wkey{})
	h.mu.Unlock()
	run(evs)
}

// release takes a watch out of its room (h.mu held).
func (h *Hub) release(w *watch) {
	if !w.active() {
		return
	}
	if h.rooms[w.room]--; h.rooms[w.room] <= 0 {
		delete(h.rooms, w.room)
		delete(h.pending, w.room)
		delete(h.lastPos, w.room)
	}
}

// Move tells where the cursor of the user is in a watched file. The core sends at most one frame
// every Throttle (the last position wins) and nothing when the position did not change.
func (h *Hub) Move(vaultID, path string, pos Pos) error {
	if _, err := pos.wire(); err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	w := h.watches[wkey{vaultID, path}]
	if w == nil || !w.active() {
		return nil
	}
	if last, ok := h.lastPos[w.room]; ok && last == pos {
		return nil
	}
	h.lastPos[w.room] = pos
	h.pending[w.room] = pos
	h.kick()
	return nil
}

// Refresh re-reads what depends on the outside: the flag, the session, the mapping of the files to
// their rooms (a share revoked, a vault unlinked, an account changed). Call it when the
// configuration, the session or the shares change. Watches that cannot be resolved any more are
// suspended (the UI is told with presence:cleared) and resume at the next Refresh that resolves them.
func (h *Hub) Refresh(ctx context.Context) {
	h.refreshMu.Lock()
	defer h.refreshMu.Unlock()
	c, enabled := h.o.Client(), h.o.Enabled()
	h.mu.Lock()
	h.disabled = false
	h.blocked = map[transport.PresenceRoom]bool{}
	keys := make([]wkey, 0, len(h.watches))
	for k := range h.watches {
		keys = append(keys, k)
	}
	h.mu.Unlock()
	type res struct {
		room transport.PresenceRoom
	}
	resolved := make(map[wkey]res, len(keys))
	if enabled && c != nil {
		for _, k := range keys {
			cloud, file, reason := h.o.Resolve(ctx, k.vault, k.path)
			if reason == "" {
				resolved[k] = res{transport.PresenceRoom{Vault: cloud, File: file}}
			}
		}
	}
	h.mu.Lock()
	var evs []func()
	for _, k := range keys { // only the watches that were resolved: one born meanwhile is left alone
		w := h.watches[k]
		if w == nil {
			continue
		}
		nr := resolved[k].room
		if nr == w.room {
			continue
		}
		if w.active() {
			evs = append(evs, h.clearedFor(k))
		}
		h.release(w)
		w.room = nr
		if w.active() {
			h.rooms[nr]++
		}
	}
	// A new login: the old connection (and the identity it was authenticated as) goes.
	if h.cur != nil && h.cur.client != c {
		evs = append(evs, h.dropSession()...)
	}
	evs = append(evs, h.afterChange(c, enabled, wkey{})...)
	h.mu.Unlock()
	run(evs)
}

func (h *Hub) serverDisabled(c *transport.Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.disabled || (c != nil && h.suspended == c)
}

// afterChange brings the connection in line with the watches (h.mu held): opens it, arms or stops
// the linger, and gives a new watcher the members already known. It returns events to run unlocked.
func (h *Hub) afterChange(c *transport.Client, enabled bool, newKey wkey) []func() {
	var evs []func()
	want := len(h.rooms) > 0 && c != nil && !h.closed && !h.disabled && h.suspended != c && enabled
	switch {
	case want:
		if h.linger != nil {
			h.linger.Stop()
			h.linger = nil
		}
		if h.cur != nil && h.cur.client != c {
			evs = append(evs, h.dropSession()...)
		}
		if h.cur == nil {
			h.startSession(c)
		}
		if w := h.watches[newKey]; w != nil && w.active() && h.cur != nil {
			if ms, ok := h.cur.members[w.room]; ok {
				evs = append(evs, h.membersEvent(newKey, ms))
			}
		}
		h.kick()
	case len(h.rooms) == 0 && h.cur != nil && !h.closed && c != nil && enabled && !h.disabled && h.suspended != c:
		if h.linger == nil {
			h.linger = time.AfterFunc(h.o.Linger, h.lingerFired)
		}
		h.kick() // the leaves
	default:
		evs = append(evs, h.dropSession()...)
	}
	return evs
}

func (h *Hub) lingerFired() {
	h.mu.Lock()
	h.linger = nil
	var evs []func()
	if len(h.rooms) == 0 {
		evs = h.dropSession()
	}
	h.mu.Unlock()
	run(evs)
}

func (h *Hub) kick() {
	if h.cur == nil {
		return
	}
	select {
	case h.cur.wake <- struct{}{}:
	default:
	}
}

// startSession opens the connection in the background (h.mu held).
func (h *Hub) startSession(c *transport.Client) {
	ctx, cancel := context.WithCancel(h.root)
	s := &session{
		client: c, cancel: cancel, wake: make(chan struct{}, 1),
		joined: map[transport.PresenceRoom]bool{}, members: map[transport.PresenceRoom]map[string]Member{},
		moves: map[moveKey]Pos{},
	}
	h.cur = s
	go h.loop(ctx, s)
}

// dropSession ends the connection and tells the UI that nothing is known any more (h.mu held).
func (h *Hub) dropSession() []func() {
	s := h.cur
	if s == nil {
		return nil
	}
	h.cur = nil
	s.cancel()
	if s.flush != nil {
		s.flush.Stop()
	}
	var evs []func()
	keys := h.sortedKeys()
	for _, k := range keys {
		w := h.watches[k]
		if w.active() && s.joined[w.room] {
			evs = append(evs, h.clearedFor(k))
		}
	}
	return evs
}

func (h *Hub) sortedKeys() []wkey {
	keys := make([]wkey, 0, len(h.watches))
	for k := range h.watches {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].vault != keys[j].vault {
			return keys[i].vault < keys[j].vault
		}
		return keys[i].path < keys[j].path
	})
	return keys
}

func (h *Hub) clearedFor(k wkey) func() {
	return func() { EventCleared.Send(h.o.Emit, Cleared{VaultID: k.vault, Path: k.path}) }
}

func (h *Hub) membersEvent(k wkey, ms map[string]Member) func() {
	list := make([]Member, 0, len(ms))
	for _, m := range ms {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].SID < list[j].SID })
	return func() { EventMembers.Send(h.o.Emit, MembersChanged{VaultID: k.vault, Path: k.path, Members: list}) }
}

// keysOf lists the active watches of a room (h.mu held).
func (h *Hub) keysOf(room transport.PresenceRoom) []wkey {
	var ks []wkey
	for _, k := range h.sortedKeys() {
		if w := h.watches[k]; w.active() && w.room == room {
			ks = append(ks, k)
		}
	}
	return ks
}

// loop keeps one session alive: reconnects with backoff until the session is dropped.
func (h *Hub) loop(ctx context.Context, s *session) {
	delay := h.o.BackoffBase
	for ctx.Err() == nil {
		healthy := false
		err := h.connect(ctx, s, &healthy)
		h.ended(s)
		if ctx.Err() != nil {
			return
		}
		var stop transport.ErrPresenceStopped
		if errors.As(err, &stop) {
			h.mu.Lock()
			if stop.Code == transport.PresenceCodeSuspended {
				h.suspended = s.client
			} else {
				h.disabled = true
			}
			evs := h.dropIf(s)
			h.mu.Unlock()
			run(evs)
			return
		}
		if healthy || errors.Is(err, transport.ErrPresenceAuth) {
			delay = h.o.BackoffBase // a token that ran out is renewed at once; a working link starts again
		}
		if errors.Is(err, transport.ErrPresenceRateLimited) {
			delay = h.o.BackoffMax // the server asked for calm
		}
		h.o.Log.Debug().Err(err).Dur("retry", delay).Msg("presence: connection ended")
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		delay = min(delay*2, h.o.BackoffMax)
	}
}

// dropIf drops the session when it is still the current one (h.mu held).
func (h *Hub) dropIf(s *session) []func() {
	if h.cur != s {
		return nil
	}
	return h.dropSession()
}

// ended forgets what a finished connection knew and tells the UI (the session stays: the loop
// reconnects).
func (h *Hub) ended(s *session) {
	h.mu.Lock()
	var evs []func()
	if h.cur == s {
		for _, k := range h.sortedKeys() {
			if w := h.watches[k]; w.active() && s.joined[w.room] {
				evs = append(evs, h.clearedFor(k))
			}
		}
		s.sid, s.ready = "", false
		s.joined = map[transport.PresenceRoom]bool{}
		s.members = map[transport.PresenceRoom]map[string]Member{}
		s.moves = map[moveKey]Pos{}
	}
	h.mu.Unlock()
	run(evs)
}

// connect runs one connection until it fails or ends.
func (h *Hub) connect(ctx context.Context, s *session, healthy *bool) error {
	conn, err := s.client.DialPresence(ctx)
	if err != nil {
		return err
	}
	cctx, cancel := context.WithCancel(ctx)
	errc := make(chan error, 1)
	go func() { errc <- h.read(cctx, conn, s, healthy) }()
	got := false
	defer func() { // the reader must be gone before the next connection starts using the session
		cancel()
		conn.Close()
		if !got {
			awaitReader(errc)
		}
	}()

	renew := time.NewTimer(time.Until(conn.RenewAt()))
	defer renew.Stop()
	ping := time.NewTicker(h.o.Ping)
	defer ping.Stop()
	mt := time.NewTimer(time.Hour)
	defer mt.Stop()
	for {
		wait, err := h.flush(ctx, conn, s)
		if err != nil {
			return err
		}
		if wait > 0 {
			mt.Reset(wait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errc:
			got = true
			return err
		case <-s.wake:
		case <-mt.C:
		case <-renew.C:
			if err := conn.Reauth(ctx); err != nil {
				return err
			}
			renew.Reset(max(time.Until(conn.RenewAt()), time.Second))
		case <-ping.C:
			if err := conn.Send(ctx, transport.PresenceFrame{T: "ping"}); err != nil {
				return err
			}
		}
	}
}

// maxRooms is the limit of the server per connection.
const maxRooms = 16

// flush sends what is due: leaves, joins, one move. It returns how long to wait for a move held back
// by the throttle.
func (h *Hub) flush(ctx context.Context, conn *transport.PresenceConn, s *session) (time.Duration, error) {
	for {
		var f *transport.PresenceFrame
		var wait time.Duration
		h.mu.Lock()
		if h.cur != s || !s.ready {
			h.mu.Unlock()
			return 0, nil
		}
		for r := range s.joined {
			if h.rooms[r] == 0 {
				r := r
				delete(s.joined, r)
				delete(s.members, r)
				f = &transport.PresenceFrame{T: "leave", Room: &r}
				break
			}
		}
		if f == nil && len(s.joined) < maxRooms {
			for r := range h.rooms {
				if !s.joined[r] && !h.blocked[r] {
					r := r
					s.joined[r] = true
					if p, ok := h.lastPos[r]; ok {
						h.pending[r] = p // after a reconnection the others see where we are
					}
					f = &transport.PresenceFrame{T: "join", Room: &r}
					break
				}
			}
		}
		if f == nil && len(h.pending) > 0 {
			if since := time.Since(h.lastMove); since < h.o.Throttle {
				wait = h.o.Throttle - since
			} else {
				for r, p := range h.pending {
					if !s.joined[r] {
						continue
					}
					raw, err := p.wire()
					delete(h.pending, r)
					if err != nil {
						continue
					}
					r := r
					f = &transport.PresenceFrame{T: "move", Room: &r, Pos: raw}
					h.lastMove = time.Now()
					break
				}
			}
		}
		h.mu.Unlock()
		if f == nil {
			return wait, nil
		}
		if err := conn.Send(ctx, *f); err != nil {
			return 0, err
		}
	}
}

// read handles the frames of the server.
func (h *Hub) read(ctx context.Context, conn *transport.PresenceConn, s *session, healthy *bool) error {
	for {
		f, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var evs []func()
		self := h.o.UserID() // before the lock: the session's lock may be held while it calls Refresh
		h.mu.Lock()
		if h.cur != s {
			h.mu.Unlock()
			return context.Canceled
		}
		isSelf := func(m transport.PresenceMember) bool {
			return (s.sid != "" && m.SID == s.sid) || (self != "" && m.UserID == self)
		}
		switch f.T {
		case "ready":
			s.sid, s.ready = f.SID, true
			*healthy = true
			h.kick()
		case "members":
			if f.Room == nil || h.rooms[*f.Room] == 0 {
				break
			}
			ms := map[string]Member{}
			for _, m := range f.List {
				if !isSelf(m) {
					ms[m.SID] = memberOf(m)
				}
			}
			s.members[*f.Room] = ms
			evs = h.announce(*f.Room, s, evs)
		case "joined":
			if f.Room == nil || f.Member == nil || h.rooms[*f.Room] == 0 || isSelf(*f.Member) {
				break
			}
			if s.members[*f.Room] == nil {
				s.members[*f.Room] = map[string]Member{}
			}
			s.members[*f.Room][f.Member.SID] = memberOf(*f.Member)
			evs = h.announce(*f.Room, s, evs)
		case "left":
			if f.Room == nil || s.members[*f.Room] == nil {
				break
			}
			if _, ok := s.members[*f.Room][f.SID]; ok {
				delete(s.members[*f.Room], f.SID)
				delete(s.moves, moveKey{*f.Room, f.SID})
				evs = h.announce(*f.Room, s, evs)
			}
		case "move":
			if f.Room == nil {
				break
			}
			if _, ok := s.members[*f.Room][f.SID]; !ok {
				break // the own sid, another device of the user, or somebody not announced
			}
			if p, ok := posFromWire(f.Pos); ok {
				s.moves[moveKey{*f.Room, f.SID}] = p
				if s.flush == nil {
					s.flush = time.AfterFunc(h.o.MoveFlush, func() { h.flushMoves(s) })
				}
			}
		case "error":
			switch {
			case f.Room == nil:
				// Without a room the server closes the channel: Read reports the codes that stop it.
				h.o.Log.Debug().Str("code", f.Code).Msg("presence: error from the server")
			case h.rooms[*f.Room] == 0:
			default:
				r := *f.Room
				delete(s.joined, r)
				delete(s.members, r)
				delete(h.pending, r)
				if f.Code != transport.PresenceCodeNotJoined { // that one only means "join again"
					h.blocked[r] = true
				}
				for _, k := range h.keysOf(r) {
					evs = append(evs, h.clearedFor(k))
				}
				h.kick()
			}
		}
		h.mu.Unlock()
		run(evs)
	}
}

// announce adds the event with the members of a room for each file that watches it (h.mu held).
func (h *Hub) announce(r transport.PresenceRoom, s *session, evs []func()) []func() {
	for _, k := range h.keysOf(r) {
		evs = append(evs, h.membersEvent(k, s.members[r]))
	}
	return evs
}

// flushMoves sends the coalesced positions to the UI.
func (h *Hub) flushMoves(s *session) {
	h.mu.Lock()
	var evs []func()
	if h.cur == s {
		s.flush = nil
		mv := s.moves
		s.moves = map[moveKey]Pos{}
		keys := make([]moveKey, 0, len(mv))
		for k := range mv {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i].sid < keys[j].sid })
		for _, mk := range keys {
			pos := mv[mk]
			for _, k := range h.keysOf(mk.room) {
				k := k
				evs = append(evs, func() {
					EventMove.Send(h.o.Emit, MemberMoved{VaultID: k.vault, Path: k.path, SID: mk.sid, Pos: pos})
				})
			}
		}
	}
	h.mu.Unlock()
	run(evs)
}

// awaitReader waits for the reader goroutine of a connection to end.
func awaitReader(c <-chan error) {
	for range c { // one value, then the reader is done
		return
	}
}
