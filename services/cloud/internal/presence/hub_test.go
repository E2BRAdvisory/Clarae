package presence

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
)

type recBus struct {
	mu   sync.Mutex
	msgs []Wire
}

func (b *recBus) add(w Wire) { b.mu.Lock(); b.msgs = append(b.msgs, w); b.mu.Unlock() }
func (b *recBus) Join(r Room, m Member) {
	b.add(Wire{Kind: WireJoin, Vault: r.Vault, File: r.File, SID: m.SID, User: m.User, Name: m.Name})
}
func (b *recBus) Leave(r Room, sid string) {
	b.add(Wire{Kind: WireLeave, Vault: r.Vault, File: r.File, SID: sid})
}
func (b *recBus) Move(r Room, sid string, pos json.RawMessage) {
	b.add(Wire{Kind: WireMove, Vault: r.Vault, File: r.File, SID: sid, Pos: pos})
}
func (b *recBus) kinds() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var s string
	for _, m := range b.msgs {
		s += m.Kind
	}
	return s
}

func newConn(h *Hub, sid, name string) *Conn {
	return h.NewConn(sid, uuid.Must(uuid.NewV7()), name)
}

func frames(c *Conn) []map[string]any {
	ctl, _ := c.out.takeControl()
	var out []map[string]any
	for _, f := range ctl {
		var m map[string]any
		_ = json.Unmarshal(f, &m)
		out = append(out, m)
	}
	return out
}

func TestOutboxMovesAreLatestWinsPerSender(t *testing.T) {
	o := newOutbox()
	room := newRoom()
	k1, k2 := moveKey{room, "a"}, moveKey{room, "b"}
	o.move(k1, []byte("a1"))
	o.move(k2, []byte("b1"))
	o.move(k1, []byte("a2"))
	got := o.takeMoves()
	if len(got) != 2 || string(got[0]) != "a2" || string(got[1]) != "b1" {
		t.Fatalf("moves = %q", got)
	}
	if o.hasMoves() {
		t.Fatal("moves not cleared")
	}
	for i := 0; i < maxControlQueue+10; i++ {
		o.control([]byte("x"))
	}
	if _, overflow := o.takeControl(); !overflow {
		t.Fatal("a control queue past its bound must report overflow")
	}
}

func TestHubJoinLeaveAndSnapshot(t *testing.T) {
	h := NewHub(zerolog.Nop(), nil)
	room := newRoom()
	a, b := newConn(h, "a", "Ann"), newConn(h, "b", "Bob")
	if l := h.Join(a, room); len(l) != 1 {
		t.Fatalf("members = %v", l)
	}
	if l := h.Join(b, room); len(l) != 2 {
		t.Fatalf("members = %v", l)
	}
	if f := frames(a); len(f) != 1 || f[0]["t"] != "joined" {
		t.Fatalf("ann got %v", f)
	}
	// Joining twice announces nothing.
	h.Join(b, room)
	if f := frames(a); len(f) != 0 {
		t.Fatalf("second join announced: %v", f)
	}
	h.Leave(b, room)
	if f := frames(a); len(f) != 1 || f[0]["t"] != "left" || f[0]["sid"] != "b" {
		t.Fatalf("ann got %v", f)
	}
	h.Drop(a)
	if rooms, conns := h.Stats(); rooms != 0 || conns != 0 {
		// users are counted by Admit; none was admitted here
		t.Fatalf("rooms=%d conns=%d", rooms, conns)
	}
}

func TestMoveReachesOnlyTheOthersAndOnlyTheRoom(t *testing.T) {
	h := NewHub(zerolog.Nop(), nil)
	r1, r2 := newRoom(), newRoom()
	a, b, c := newConn(h, "a", "A"), newConn(h, "b", "B"), newConn(h, "c", "C")
	h.Join(a, r1)
	h.Join(b, r1)
	h.Join(c, r2)
	if !h.Move(a, r1, json.RawMessage(`{"k":"text","line":1,"col":2}`)) {
		t.Fatal("move refused")
	}
	if len(b.out.takeMoves()) != 1 || len(a.out.takeMoves()) != 0 || len(c.out.takeMoves()) != 0 {
		t.Fatal("a position must reach the other members of its room only")
	}
	if h.Move(c, r1, json.RawMessage(`{}`)) {
		t.Fatal("a non-member moved")
	}
}

func TestConnectionSlots(t *testing.T) {
	h := NewHub(zerolog.Nop(), nil)
	u := uuid.Must(uuid.NewV7())
	for i := 0; i < MaxConnsPerUser; i++ {
		if !h.Admit(u) {
			t.Fatalf("slot %d refused", i)
		}
	}
	if h.Admit(u) {
		t.Fatal("33rd slot granted")
	}
	c := h.NewConn("x", u, "n")
	h.Drop(c) // frees one
	if !h.Admit(u) {
		t.Fatal("slot not freed")
	}
}

func TestMovesAreNotPublishedWithoutRemoteMembers(t *testing.T) {
	bus := &recBus{}
	h := NewHub(zerolog.Nop(), bus)
	room := newRoom()
	a, b := newConn(h, "a", "A"), newConn(h, "b", "B")
	h.Join(a, room)
	h.Join(b, room)
	h.Move(a, room, json.RawMessage(`{"k":"text"}`))
	if k := bus.kinds(); k != "jj" {
		t.Fatalf("bus saw %q: moves of a room that lives on one replica must stay in memory", k)
	}
	// Once another replica has a member there, they are.
	h.HandleRemote(Wire{Replica: "other", Kind: WireJoin, Vault: room.Vault, File: room.File, SID: "r1", User: uuid.New(), Name: "Remote"})
	h.Move(a, room, json.RawMessage(`{"k":"text"}`))
	if k := bus.kinds(); k != "jjm" {
		t.Fatalf("bus saw %q", k)
	}
	h.HandleRemote(Wire{Replica: "other", Kind: WireLeave, Vault: room.Vault, File: room.File, SID: "r1"})
	h.Move(a, room, json.RawMessage(`{"k":"text"}`))
	if k := bus.kinds(); k != "jjm" {
		t.Fatalf("bus saw %q after the remote member left", k)
	}
}

func TestRemoteMembersAppearInSnapshotsAndEvents(t *testing.T) {
	h := NewHub(zerolog.Nop(), nil)
	room := newRoom()
	a := newConn(h, "a", "A")
	h.Join(a, room)
	frames(a)
	uid := uuid.Must(uuid.NewV7())
	join := Wire{Replica: "other", Kind: WireJoin, Vault: room.Vault, File: room.File, SID: "r1", User: uid, Name: "Remote"}
	h.HandleRemote(join)
	if f := frames(a); len(f) != 1 || f[0]["t"] != "joined" {
		t.Fatalf("ann got %v", f)
	}
	// A heartbeat is silent.
	h.HandleRemote(join)
	if f := frames(a); len(f) != 0 {
		t.Fatalf("heartbeat announced: %v", f)
	}
	b := newConn(h, "b", "B")
	if l := h.Join(b, room); len(l) != 3 {
		t.Fatalf("snapshot lacks the remote member: %v", l)
	}
	h.HandleRemote(Wire{Replica: "other", Kind: WireMove, Vault: room.Vault, File: room.File, SID: "r1", Pos: json.RawMessage(`{"k":"scene"}`)})
	if len(a.out.takeMoves()) != 1 || len(b.out.takeMoves()) != 1 {
		t.Fatal("remote move not delivered to the local members")
	}
	// Our own messages are ignored.
	h.HandleRemote(Wire{Replica: h.Replica(), Kind: WireJoin, Vault: room.Vault, File: room.File, SID: "me", User: uid})
	if len(h.RemoteMembers(room)) != 1 {
		t.Fatal("an echo of our own join was applied")
	}
}

func TestStaleRemoteMembersExpire(t *testing.T) {
	h := NewHub(zerolog.Nop(), nil)
	now := time.Now()
	h.now = func() time.Time { return now }
	room := newRoom()
	a := newConn(h, "a", "A")
	h.Join(a, room)
	h.HandleRemote(Wire{Replica: "other", Kind: WireJoin, Vault: room.Vault, File: room.File, SID: "r1", User: uuid.New(), Name: "R"})
	frames(a)
	now = now.Add(RemoteTTL + time.Second)
	h.Sweep()
	if f := frames(a); len(f) != 1 || f[0]["t"] != "left" || f[0]["sid"] != "r1" {
		t.Fatalf("expiry: %v", f)
	}
	if len(h.RemoteMembers(room)) != 0 {
		t.Fatal("stale member kept")
	}
}

func TestAnnounceRepeatsLocalMembers(t *testing.T) {
	bus := &recBus{}
	h := NewHub(zerolog.Nop(), bus)
	room := newRoom()
	h.Join(newConn(h, "a", "A"), room)
	h.Join(newConn(h, "b", "B"), room)
	before := len(bus.msgs)
	h.HandleRemote(Wire{Replica: "other", Kind: WireHello})
	if got := len(bus.msgs) - before; got != 2 {
		t.Fatalf("hello answered with %d joins, want 2", got)
	}
}

func TestWireStaysUnderTheNotifyLimit(t *testing.T) {
	w := Wire{Replica: uuid.NewString(), Kind: WireMove, Vault: uuid.New(), File: uuid.New(), SID: strings.Repeat("s", 16), User: uuid.New(),
		Name: truncateName(strings.Repeat("é", 500)), Pos: json.RawMessage(`"` + strings.Repeat("p", MaxPosBytes-2) + `"`)}
	raw, _ := json.Marshal(w)
	if len(raw) >= maxPayload {
		t.Fatalf("payload %d B", len(raw))
	}
	if n := truncateName(strings.Repeat("é", 500)); len(n) > MaxNameBytes || !strings.HasSuffix(n, "é") {
		t.Fatalf("truncate = %q", n)
	}
}

func TestAnnounceIsCompleteAndNotDroppedByTheBusQueue(t *testing.T) {
	bus := &recBus{}
	h := NewHub(zerolog.Nop(), bus)
	room := newRoom()
	const n = 5000
	for i := 0; i < n; i++ {
		h.Join(newConn(h, uuid.NewString(), "x"), room)
	}
	before := len(bus.msgs)
	h.Announce()
	if got := len(bus.msgs) - before; got != n {
		t.Fatalf("heartbeat published %d of %d members", got, n)
	}
	// The real queue keeps a heartbeat of that size whole.
	pg := NewPGBus(nil, zerolog.Nop(), h)
	for i := 0; i < n; i++ {
		pg.Join(room, Member{SID: "s", User: uuid.New(), Name: "x"})
	}
	if got := len(pg.take()); got != n {
		t.Fatalf("queue kept %d of %d", got, n)
	}
}

// A leave published after a heartbeat's join of the same member must win: the
// heartbeat is queued under the lock that the leave needs to remove the member.
func TestLeaveNeverOvertakesTheHeartbeatJoin(t *testing.T) {
	bus := &recBus{}
	h := NewHub(zerolog.Nop(), bus)
	room := newRoom()
	c := newConn(h, "a", "A")
	h.Join(c, room)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			h.Announce()
		}
	}()
	h.Leave(c, room)
	<-done
	bus.mu.Lock()
	defer bus.mu.Unlock()
	lastLeave, lastJoin := -1, -1
	for i, m := range bus.msgs {
		switch m.Kind {
		case WireLeave:
			lastLeave = i
		case WireJoin:
			lastJoin = i
		}
	}
	if lastLeave < lastJoin {
		t.Fatalf("a join (%d) follows the leave (%d): ghost member", lastJoin, lastLeave)
	}
}
