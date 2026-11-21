// Package presence tells the users of a shared vault who else has the same
// document open and where their pointer is (M25, ADR-0065). It is ephemeral
// by design: nothing is written to a table, nothing goes to the audit log and
// no frame is logged. The server stamps the identity of each member and
// authorizes each room, but never interprets a position: it is opaque JSON
// that the clients agree on.
//
// A connection is a WebSocket (GET /api/v1/presence, see ws.go). Rooms live in
// memory on the replica that holds the connections; replicas learn about each
// other through the PostgreSQL channel "presence" (bus.go).
package presence

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
)

// RemoteTTL is how long a member announced by another replica is believed
// without a new announcement (which come every HeartbeatEvery): a replica that
// died cannot say goodbye.
const (
	RemoteTTL      = 70 * time.Second
	HeartbeatEvery = 20 * time.Second
)

// Bus carries the events of the rooms to the other replicas. Methods never
// block: an implementation queues and may drop, the heartbeat heals it.
type Bus interface {
	Join(room Room, m Member)
	Leave(room Room, sid string)
	// Move is called only for rooms with members on other replicas.
	Move(room Room, sid string, pos json.RawMessage)
}

// Conn is one authenticated connection as the hub knows it.
type Conn struct {
	SID  string
	User uuid.UUID
	Name string

	out   *outbox
	rooms map[Room]struct{} // guarded by Hub.mu
}

// Out returns the channel-like mailbox the handler drains (see outbox).
func (c *Conn) Out() *outbox { return c.out }

type remoteMember struct {
	m       Member
	replica string
	seen    time.Time
}

type roomState struct {
	local  map[*Conn]struct{}
	remote map[string]remoteMember // by sid
}

func (r *roomState) empty() bool { return len(r.local) == 0 && len(r.remote) == 0 }

// Hub keeps the rooms of one replica.
type Hub struct {
	log     zerolog.Logger
	replica string
	bus     Bus
	now     func() time.Time

	mu    sync.RWMutex
	rooms map[Room]*roomState
	users map[uuid.UUID]int
}

// NewHub creates a hub; bus may be nil (a single replica).
func NewHub(log zerolog.Logger, bus Bus) *Hub {
	return &Hub{log: log, replica: uuid.NewString(), bus: bus, now: time.Now,
		rooms: map[Room]*roomState{}, users: map[uuid.UUID]int{}}
}

// Replica identifies this hub on the bus.
func (h *Hub) Replica() string { return h.replica }

// SetBus sets the bus before the hub serves.
func (h *Hub) SetBus(b Bus) { h.bus = b }

// Admit reserves a connection slot for the user (MaxConnsPerUser); false when full.
func (h *Hub) Admit(user uuid.UUID) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.users[user] >= MaxConnsPerUser {
		return false
	}
	h.users[user]++
	return true
}

// NewConn creates the connection of an admitted user and registers its slot release in Drop.
func (h *Hub) NewConn(sid string, user uuid.UUID, name string) *Conn {
	return &Conn{SID: sid, User: user, Name: name, out: newOutbox(), rooms: map[Room]struct{}{}}
}

func (c *Conn) member() Member { return Member{SID: c.SID, User: c.User, Name: c.Name} }

// Join puts c in the room and returns who is there, c included. Joining twice is harmless.
func (h *Hub) Join(c *Conn, room Room) []Member {
	h.mu.Lock()
	rs := h.rooms[room]
	if rs == nil {
		rs = &roomState{local: map[*Conn]struct{}{}, remote: map[string]remoteMember{}}
		h.rooms[room] = rs
	}
	_, already := rs.local[c]
	rs.local[c] = struct{}{}
	c.rooms[room] = struct{}{}
	list := h.membersLocked(rs)
	var others []*Conn
	if !already {
		for o := range rs.local {
			if o != c {
				others = append(others, o)
			}
		}
	}
	h.mu.Unlock()
	if !already {
		m := c.member()
		f := marshal(outFrame{T: TJoined, Room: &room, Member: &m})
		for _, o := range others {
			o.out.control(f)
		}
		if h.bus != nil {
			h.bus.Join(room, m)
		}
	}
	return list
}

func (h *Hub) membersLocked(rs *roomState) []Member {
	list := make([]Member, 0, len(rs.local)+len(rs.remote))
	for c := range rs.local {
		list = append(list, c.member())
	}
	for _, r := range rs.remote {
		list = append(list, r.m)
	}
	return list
}

// Rooms returns the rooms c is in.
func (h *Hub) Rooms(c *Conn) []Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]Room, 0, len(c.rooms))
	for r := range c.rooms {
		out = append(out, r)
	}
	return out
}

// RoomCount is how many rooms c is in.
func (h *Hub) RoomCount(c *Conn) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(c.rooms)
}

// In reports whether c is in the room.
func (h *Hub) In(c *Conn, room Room) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := c.rooms[room]
	return ok
}

// Members returns who is in the room if c is still in it, under the same lock
// that Join and Leave take: a join of a member that a concurrent recheck just
// threw out cannot be answered from here, it must be authorized again.
func (h *Hub) Members(c *Conn, room Room) ([]Member, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	rs := h.rooms[room]
	if rs == nil {
		return nil, false
	}
	if _, ok := rs.local[c]; !ok {
		return nil, false
	}
	return h.membersLocked(rs), true
}

// Leave takes c out of the room and tells the others.
func (h *Hub) Leave(c *Conn, room Room) {
	h.mu.Lock()
	others, was := h.leaveLocked(c, room)
	h.mu.Unlock()
	if was {
		h.announceLeft(c, room, others)
	}
}

func (h *Hub) leaveLocked(c *Conn, room Room) (others []*Conn, was bool) {
	rs := h.rooms[room]
	if rs == nil {
		return nil, false
	}
	if _, ok := rs.local[c]; !ok {
		return nil, false
	}
	delete(rs.local, c)
	delete(c.rooms, room)
	for o := range rs.local {
		others = append(others, o)
	}
	if rs.empty() {
		delete(h.rooms, room)
	}
	return others, true
}

func (h *Hub) announceLeft(c *Conn, room Room, others []*Conn) {
	f := marshal(outFrame{T: TLeft, Room: &room, SID: c.SID})
	for _, o := range others {
		o.out.control(f)
	}
	if h.bus != nil {
		h.bus.Leave(room, c.SID)
	}
}

// Drop removes c from every room, closes its mailbox and frees its slot.
func (h *Hub) Drop(c *Conn) {
	type left struct {
		room   Room
		others []*Conn
	}
	var gone []left
	h.mu.Lock()
	for room := range c.rooms {
		if others, ok := h.leaveLocked(c, room); ok {
			gone = append(gone, left{room, others})
		}
	}
	if n := h.users[c.User]; n <= 1 {
		delete(h.users, c.User)
	} else {
		h.users[c.User] = n - 1
	}
	h.mu.Unlock()
	for _, g := range gone {
		h.announceLeft(c, g.room, g.others)
	}
	c.out.close()
}

// Move sends the position of c to the others of the room. It reports false
// when c is not in the room.
func (h *Hub) Move(c *Conn, room Room, pos json.RawMessage) bool {
	h.mu.RLock()
	rs := h.rooms[room]
	if rs == nil {
		h.mu.RUnlock()
		return false
	}
	if _, ok := rs.local[c]; !ok {
		h.mu.RUnlock()
		return false
	}
	var targets []*Conn
	for o := range rs.local {
		if o != c {
			targets = append(targets, o)
		}
	}
	remote := len(rs.remote) > 0
	h.mu.RUnlock()
	h.deliverMove(room, c.SID, pos, targets)
	if remote && h.bus != nil {
		h.bus.Move(room, c.SID, pos)
	}
	return true
}

func (h *Hub) deliverMove(room Room, sid string, pos json.RawMessage, targets []*Conn) {
	if len(targets) == 0 {
		return
	}
	f := marshal(outFrame{T: TMove, Room: &room, SID: sid, Pos: pos})
	key := moveKey{room, sid}
	for _, o := range targets {
		o.out.move(key, f)
	}
}

// localTargets lists the local members of a room.
func (h *Hub) localTargets(room Room) []*Conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	rs := h.rooms[room]
	if rs == nil {
		return nil
	}
	out := make([]*Conn, 0, len(rs.local))
	for o := range rs.local {
		out = append(out, o)
	}
	return out
}

// Wire is a message between replicas, the payload of NOTIFY on the channel "presence".
type Wire struct {
	Replica string          `json:"r"`
	Kind    string          `json:"k"` // j(oin), l(eave), m(ove), h(ello)
	Vault   uuid.UUID       `json:"v,omitempty"`
	File    uuid.UUID       `json:"f,omitempty"`
	SID     string          `json:"s,omitempty"`
	User    uuid.UUID       `json:"u,omitempty"`
	Name    string          `json:"n,omitempty"`
	Pos     json.RawMessage `json:"p,omitempty"`
}

// Wire kinds.
const (
	WireJoin  = "j"
	WireLeave = "l"
	WireMove  = "m"
	WireHello = "h"
)

// HandleRemote applies a message from another replica.
func (h *Hub) HandleRemote(w Wire) {
	if w.Replica == h.replica {
		return
	}
	room := Room{Vault: w.Vault, File: w.File}
	switch w.Kind {
	case WireJoin:
		if w.SID == "" || w.User == uuid.Nil {
			return
		}
		m := Member{SID: w.SID, User: w.User, Name: w.Name}
		h.mu.Lock()
		rs := h.rooms[room]
		if rs == nil {
			rs = &roomState{local: map[*Conn]struct{}{}, remote: map[string]remoteMember{}}
			h.rooms[room] = rs
		}
		_, known := rs.remote[w.SID]
		rs.remote[w.SID] = remoteMember{m: m, replica: w.Replica, seen: h.now()}
		var targets []*Conn
		if !known {
			for o := range rs.local {
				targets = append(targets, o)
			}
		}
		h.mu.Unlock()
		f := marshal(outFrame{T: TJoined, Room: &room, Member: &m})
		for _, o := range targets {
			o.out.control(f)
		}
	case WireLeave:
		h.removeRemote(room, w.SID)
	case WireMove:
		h.deliverMove(room, w.SID, w.Pos, h.localTargets(room))
	case WireHello:
		h.Announce()
	}
}

func (h *Hub) removeRemote(room Room, sid string) {
	h.mu.Lock()
	rs := h.rooms[room]
	var targets []*Conn
	if rs != nil {
		if _, ok := rs.remote[sid]; ok {
			delete(rs.remote, sid)
			for o := range rs.local {
				targets = append(targets, o)
			}
			if rs.empty() {
				delete(h.rooms, room)
			}
		}
	}
	h.mu.Unlock()
	f := marshal(outFrame{T: TLeft, Room: &room, SID: sid})
	for _, o := range targets {
		o.out.control(f)
	}
}

// Announce publishes every local member again: the heartbeat that keeps the
// other replicas' view alive, and the answer to a replica that just started
// listening.
func (h *Hub) Announce() {
	if h.bus == nil {
		return
	}
	// The messages are queued while the lock is held: a leave removes the member
	// under the write lock and is published after, so it can never overtake the
	// join of a heartbeat that saw the member.
	h.mu.RLock()
	defer h.mu.RUnlock()
	for room, rs := range h.rooms {
		for c := range rs.local {
			h.bus.Join(room, c.member())
		}
	}
}

// Sweep drops the remote members not announced within RemoteTTL.
func (h *Hub) Sweep() {
	type stale struct {
		room Room
		sid  string
	}
	var gone []stale
	cutoff := h.now().Add(-RemoteTTL)
	h.mu.RLock()
	for room, rs := range h.rooms {
		for sid, r := range rs.remote {
			if r.seen.Before(cutoff) {
				gone = append(gone, stale{room, sid})
			}
		}
	}
	h.mu.RUnlock()
	for _, g := range gone {
		h.removeRemote(g.room, g.sid)
	}
}

// Stats reports how many rooms and connections this replica holds.
func (h *Hub) Stats() (rooms, conns int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, n := range h.users {
		conns += n
	}
	return len(h.rooms), conns
}

// RemoteMembers lists the members announced by other replicas for a room (tests, diagnostics).
func (h *Hub) RemoteMembers(room Room) []Member {
	h.mu.RLock()
	defer h.mu.RUnlock()
	rs := h.rooms[room]
	if rs == nil {
		return nil
	}
	var out []Member
	for _, r := range rs.remote {
		out = append(out, r.m)
	}
	return out
}
