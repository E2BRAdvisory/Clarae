//go:build !js

package presence

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"clarae/apps/desktop/internal/sync/transport"
)

type tokens struct{ exp int64 }

func (t tokens) Token(context.Context) (string, error) {
	if t.exp == 0 {
		return "opaque", nil
	}
	pl, _ := json.Marshal(map[string]any{"exp": t.exp})
	return "h." + base64.RawURLEncoding.EncodeToString(pl) + ".s", nil
}

// srvConn is one connection of the fake server.
type srvConn struct {
	ws   *websocket.Conn
	in   chan transport.PresenceFrame
	sid  string
	done chan struct{}
}

func (c *srvConn) send(t testing.TB, f transport.PresenceFrame) {
	t.Helper()
	b, _ := json.Marshal(f)
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Errorf("fake server: write: %v", err)
	}
}

// next waits for a frame of the type (the others are skipped, pings included).
func (c *srvConn) next(t testing.TB, typ string) transport.PresenceFrame {
	t.Helper()
	to := time.After(3 * time.Second)
	for {
		select {
		case f := <-c.in:
			if f.T == typ {
				return f
			}
		case <-to:
			t.Fatalf("no %q frame", typ)
		}
	}
}

type fakeServer struct {
	srv   *httptest.Server
	conns chan *srvConn
	n     atomic.Int32
}

func newServer(t *testing.T) *fakeServer {
	f := &fakeServer{conns: make(chan *srvConn, 16)}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/presence" {
			http.NotFound(w, r)
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c := &srvConn{ws: ws, in: make(chan transport.PresenceFrame, 256), done: make(chan struct{})}
		c.sid = fmt.Sprintf("sid-%d", f.n.Add(1))
		ctx := r.Context()
		_, b, err := ws.Read(ctx)
		var first transport.PresenceFrame
		if err != nil || json.Unmarshal(b, &first) != nil || first.T != "auth" || first.Token == "" {
			_ = ws.Close(websocket.StatusPolicyViolation, "auth")
			return
		}
		c.in <- first
		c.send(t, transport.PresenceFrame{T: "ready", SID: c.sid})
		f.conns <- c
		defer close(c.done)
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var fr transport.PresenceFrame
			if json.Unmarshal(b, &fr) == nil {
				c.in <- fr
			}
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) accept(t testing.TB) *srvConn {
	t.Helper()
	select {
	case c := <-f.conns:
		return c
	case <-time.After(3 * time.Second):
		t.Fatal("no connection")
		return nil
	}
}

func (f *fakeServer) client(t testing.TB, exp int64) *transport.Client {
	c, err := transport.New(f.srv.URL, tokens{exp}, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type rec struct {
	mu sync.Mutex
	ev []struct {
		name string
		p    any
	}
}

func (r *rec) emit(name string, p any) {
	r.mu.Lock()
	r.ev = append(r.ev, struct {
		name string
		p    any
	}{name, p})
	r.mu.Unlock()
}

func (r *rec) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.ev {
		if e.name == name {
			n++
		}
	}
	return n
}

// last returns the payload of the last event with the name, waiting for the n-th.
func (r *rec) wait(t testing.TB, name string, n int) any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		k := 0
		for _, e := range r.ev {
			if e.name == name {
				if k++; k == n {
					r.mu.Unlock()
					return e.p
				}
			}
		}
		r.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("event %s #%d never came (have %d)", name, n, r.count(name))
	return nil
}

type env struct {
	srv     *fakeServer
	rec     *rec
	hub     *Hub
	client  atomic.Pointer[transport.Client]
	enabled atomic.Bool
	reasons sync.Map // "vault|path" -> reason
	rooms   sync.Map // "vault|path" -> PresenceRoom
}

func newEnv(t *testing.T, mut func(*Options)) *env {
	e := &env{srv: newServer(t), rec: &rec{}}
	e.enabled.Store(true)
	e.client.Store(e.srv.client(t, 0))
	o := Options{
		Client:  func() *transport.Client { return e.client.Load() },
		UserID:  func() string { return "me" },
		Enabled: e.enabled.Load,
		Resolve: func(_ context.Context, v, p string) (string, string, string) {
			if r, ok := e.reasons.Load(v + "|" + p); ok {
				return "", "", r.(string)
			}
			if r, ok := e.rooms.Load(v + "|" + p); ok {
				room := r.(transport.PresenceRoom)
				return room.Vault, room.File, ""
			}
			return "cloud-" + v, "file-" + p, ""
		},
		Emit: e.rec.emit, Linger: 150 * time.Millisecond, Throttle: 40 * time.Millisecond, MoveFlush: 10 * time.Millisecond,
		BackoffBase: 20 * time.Millisecond, BackoffMax: 100 * time.Millisecond,
	}
	if mut != nil {
		mut(&o)
	}
	e.hub = NewHub(o)
	t.Cleanup(e.hub.Close)
	return e
}

var roomA = transport.PresenceRoom{Vault: "cloud-v1", File: "file-a.md"}

func TestJoinMembersMovesAndSelfFilter(t *testing.T) {
	e := newEnv(t, nil)
	if w := e.hub.Watch(context.Background(), "v1", "a.md"); !w.Watching || w.Reason != "" {
		t.Fatalf("Watch = %+v", w)
	}
	c := e.srv.accept(t)
	if f := c.next(t, "auth"); f.Token != "opaque" {
		t.Errorf("first frame token = %q", f.Token)
	}
	if f := c.next(t, "join"); *f.Room != roomA {
		t.Errorf("join room = %+v", f.Room)
	}
	// The list holds the own session (sid-1) and another device of the same user: neither is "other".
	c.send(t, transport.PresenceFrame{T: "members", Room: &roomA, List: []transport.PresenceMember{
		{SID: c.sid, UserID: "me", Name: "Me"}, {SID: "x1", UserID: "me", Name: "Me"}, {SID: "b1", UserID: "bob", Name: "Bob"},
	}})
	p := e.rec.wait(t, "presence:members", 1).(MembersChanged)
	if p.VaultID != "v1" || p.Path != "a.md" || len(p.Members) != 1 || p.Members[0] != (Member{"b1", "bob", "Bob"}) {
		t.Fatalf("members = %+v", p)
	}
	c.send(t, transport.PresenceFrame{T: "joined", Room: &roomA, Member: &transport.PresenceMember{SID: "x2", UserID: "me", Name: "Me"}})
	c.send(t, transport.PresenceFrame{T: "joined", Room: &roomA, Member: &transport.PresenceMember{SID: "c1", UserID: "carol", Name: "Carol"}})
	p = e.rec.wait(t, "presence:members", 2).(MembersChanged)
	if len(p.Members) != 2 {
		t.Fatalf("after joined: %+v", p.Members)
	}
	// Moves: one of a member is forwarded, one of the own device or of a stranger is not; a burst coalesces.
	for i := 1; i <= 20; i++ {
		c.send(t, transport.PresenceFrame{T: "move", Room: &roomA, SID: "b1", Pos: json.RawMessage(fmt.Sprintf(`{"k":"text","line":%d,"col":2}`, i))})
	}
	c.send(t, transport.PresenceFrame{T: "move", Room: &roomA, SID: "x1", Pos: json.RawMessage(`{"k":"text","line":9,"col":9}`)})
	c.send(t, transport.PresenceFrame{T: "move", Room: &roomA, SID: "ghost", Pos: json.RawMessage(`{"k":"text","line":9,"col":9}`)})
	c.send(t, transport.PresenceFrame{T: "move", Room: &roomA, SID: "c1", Pos: json.RawMessage(`{"k":"scene","x":1.5,"y":-2}`)})
	time.Sleep(150 * time.Millisecond)
	e.rec.mu.Lock()
	var moves []MemberMoved
	for _, ev := range e.rec.ev {
		if ev.name == "presence:move" {
			moves = append(moves, ev.p.(MemberMoved))
		}
	}
	e.rec.mu.Unlock()
	last := map[string]Pos{}
	for _, m := range moves {
		last[m.SID] = m.Pos
	}
	if len(last) != 2 || last["b1"] != (Pos{Kind: "text", Line: 20, Col: 2}) || last["c1"] != (Pos{Kind: "scene", X: 1.5, Y: -2}) {
		t.Errorf("moves = %+v", moves)
	}
	if len(moves) > 6 {
		t.Errorf("%d move events for 20 frames: not coalesced", len(moves))
	}
	c.send(t, transport.PresenceFrame{T: "left", Room: &roomA, SID: "b1"})
	if p = e.rec.wait(t, "presence:members", 3).(MembersChanged); len(p.Members) != 1 || p.Members[0].SID != "c1" {
		t.Errorf("after left: %+v", p.Members)
	}
}

func TestMoveThrottleLatestWinsAndNoDuplicates(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Throttle = 80 * time.Millisecond })
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	pos := func(l int) Pos { return Pos{Kind: PosText, Line: l, Col: 1} }
	start := time.Now()
	for i := 1; i <= 30; i++ {
		if err := e.hub.Move("v1", "a.md", pos(i)); err != nil {
			t.Fatal(err)
		}
	}
	var got []int
	for len(got) < 2 {
		f := c.next(t, "move")
		var p struct{ Line int }
		_ = json.Unmarshal(f.Pos, &p)
		got = append(got, p.Line)
	}
	if got[len(got)-1] != 30 || len(got) != 2 {
		t.Errorf("frames = %v, want the first and the last position", got)
	}
	if time.Since(start) < 70*time.Millisecond {
		t.Errorf("the second frame came after %v: no throttle", time.Since(start))
	}
	// The same position again is not sent.
	_ = e.hub.Move("v1", "a.md", pos(30))
	time.Sleep(200 * time.Millisecond)
	select {
	case f := <-c.in:
		if f.T == "move" {
			t.Errorf("a position that did not change was sent: %s", f.Pos)
		}
	default:
	}
	if err := e.hub.Move("v1", "a.md", Pos{Kind: "bogus"}); err == nil {
		t.Error("an unknown kind was accepted")
	}
	if err := e.hub.Move("v1", "never-watched.md", pos(1)); err != nil {
		t.Errorf("a file that is not watched is ignored, got %v", err)
	}
}

func TestReasonsAndSharedOnly(t *testing.T) {
	e := newEnv(t, nil)
	e.reasons.Store("priv|n.md", ReasonNotShared)
	e.reasons.Store("v1|new.md", ReasonNotSynced)
	for path, want := range map[string]string{"n.md": ReasonNotShared, "new.md": ReasonNotSynced} {
		v := "priv"
		if path == "new.md" {
			v = "v1"
		}
		if w := e.hub.Watch(context.Background(), v, path); w.Watching || w.Reason != want {
			t.Errorf("%s/%s: %+v, want %q", v, path, w, want)
		}
	}
	select {
	case <-e.srv.conns:
		t.Fatal("a connection was opened for files that cannot be watched")
	case <-time.After(100 * time.Millisecond):
	}
	e.enabled.Store(false)
	if w := e.hub.Watch(context.Background(), "v1", "a.md"); w.Watching || w.Reason != ReasonDisabled {
		t.Errorf("flag off: %+v", w)
	}
	e.enabled.Store(true)
	e.client.Store(nil)
	if w := e.hub.Watch(context.Background(), "v1", "a.md"); w.Watching || w.Reason != ReasonOffline {
		t.Errorf("signed out: %+v", w)
	}
}

func TestRefcountAndLinger(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	e.hub.Unwatch("v1", "a.md")
	time.Sleep(100 * time.Millisecond)
	select {
	case f := <-c.in:
		if f.T == "leave" {
			t.Fatal("left the room while a panel still watches the file")
		}
	default:
	}
	e.hub.Unwatch("v1", "a.md")
	if f := c.next(t, "leave"); *f.Room != roomA {
		t.Errorf("leave room = %+v", f.Room)
	}
	// Watching again within the linger reuses the connection.
	e.hub.Watch(context.Background(), "v1", "b.md")
	c.next(t, "join")
	e.hub.Unwatch("v1", "b.md")
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		t.Fatal("the connection stayed open after the linger")
	}
	if n := e.srv.n.Load(); n != 1 {
		t.Errorf("%d connections, want 1", n)
	}
}

func TestReconnectsAndJoinsAgain(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	c.send(t, transport.PresenceFrame{T: "members", Room: &roomA, List: []transport.PresenceMember{{SID: "b1", UserID: "bob", Name: "Bob"}}})
	e.rec.wait(t, "presence:members", 1)
	_ = e.hub.Move("v1", "a.md", Pos{Kind: PosText, Line: 3, Col: 4})
	c.next(t, "move")
	_ = c.ws.Close(websocket.StatusGoingAway, "restart")
	cl := e.rec.wait(t, "presence:cleared", 1).(Cleared)
	if cl.VaultID != "v1" || cl.Path != "a.md" {
		t.Errorf("cleared = %+v", cl)
	}
	c2 := e.srv.accept(t)
	if f := c2.next(t, "join"); *f.Room != roomA {
		t.Errorf("rejoin room = %+v", f.Room)
	}
	// The last position is sent again: the others learn where we are.
	var p struct{ Line, Col int }
	_ = json.Unmarshal(c2.next(t, "move").Pos, &p)
	if p.Line != 3 || p.Col != 4 {
		t.Errorf("position after reconnecting = %+v", p)
	}
}

func TestServerDisabledStopsUntilRefresh(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	c.send(t, transport.PresenceFrame{T: "members", Room: &roomA, List: []transport.PresenceMember{{SID: "b1", UserID: "bob"}}})
	e.rec.wait(t, "presence:members", 1)
	c.send(t, transport.PresenceFrame{T: "error", Code: "presence-disabled"})
	e.rec.wait(t, "presence:cleared", 1)
	select {
	case <-e.srv.conns:
		t.Fatal("reconnected after presence-disabled")
	case <-time.After(300 * time.Millisecond):
	}
	if w := e.hub.Watch(context.Background(), "v1", "a.md"); w.Watching || w.Reason != ReasonDisabled {
		t.Errorf("Watch after presence-disabled = %+v", w)
	}
	e.hub.Refresh(context.Background()) // the configuration changed: try again
	e.srv.accept(t)
}

func TestHotFlagOffLogoutAndNewAccount(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	c.send(t, transport.PresenceFrame{T: "members", Room: &roomA, List: []transport.PresenceMember{{SID: "b1", UserID: "bob"}}})
	e.rec.wait(t, "presence:members", 1)

	e.enabled.Store(false)
	e.hub.Refresh(context.Background())
	e.rec.wait(t, "presence:cleared", 1)
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		t.Fatal("the connection stayed open with the flag off")
	}
	e.enabled.Store(true)
	e.hub.Refresh(context.Background()) // back on: the watch resumes by itself
	c2 := e.srv.accept(t)
	c2.next(t, "join")

	e.client.Store(nil) // sign-out
	e.hub.Refresh(context.Background())
	select {
	case <-c2.done:
	case <-time.After(3 * time.Second):
		t.Fatal("the connection stayed open after sign-out")
	}
	e.client.Store(e.srv.client(t, 0)) // another account (another client)
	e.hub.Refresh(context.Background())
	c3 := e.srv.accept(t)
	c3.next(t, "join")
	e.client.Store(e.srv.client(t, 0))
	e.hub.Refresh(context.Background())
	select {
	case <-c3.done:
	case <-time.After(3 * time.Second):
		t.Fatal("the connection of the previous login stayed open")
	}
	e.srv.accept(t).next(t, "join")
}

func TestRefreshSuspendsAWatchThatNoLongerResolves(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	c.send(t, transport.PresenceFrame{T: "members", Room: &roomA, List: []transport.PresenceMember{{SID: "b1", UserID: "bob"}}})
	e.rec.wait(t, "presence:members", 1)
	e.reasons.Store("v1|a.md", ReasonNotShared) // share revoked
	e.hub.Refresh(context.Background())
	e.rec.wait(t, "presence:cleared", 1)
	c.next(t, "leave")
	e.reasons.Delete("v1|a.md")
	e.hub.Refresh(context.Background())
	c.next(t, "join")
}

func TestTokenIsRenewedBeforeItExpires(t *testing.T) {
	e := newEnv(t, nil)
	e.client.Store(e.srv.client(t, time.Now().Unix()+30)) // expires in 30 s: renewed (at least) every second
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "auth")
	f := c.next(t, "auth")
	if f.Token == "" {
		t.Error("the renewal carries no token")
	}
}

func TestAuthRefusedReconnectsWithANewToken(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	c.send(t, transport.PresenceFrame{T: "error", Code: "token-expired"})
	e.srv.accept(t).next(t, "join")
}

func TestCloseStopsEverything(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	e.hub.Close()
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		t.Fatal("the connection stayed open after Close")
	}
	if w := e.hub.Watch(context.Background(), "v1", "a.md"); w.Watching {
		t.Error("a closed hub watches")
	}
}

func TestTwoVaultsSameRoom(t *testing.T) {
	// The owner's vault and a mount of it name the same file: one room, an event for each.
	e := newEnv(t, nil)
	e.rooms.Store("owner|a.md", roomA)
	e.rooms.Store("mount|sub/a.md", roomA)
	e.hub.Watch(context.Background(), "owner", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	e.hub.Watch(context.Background(), "mount", "sub/a.md")
	c.send(t, transport.PresenceFrame{T: "members", Room: &roomA, List: []transport.PresenceMember{{SID: "b1", UserID: "bob"}}})
	e.rec.wait(t, "presence:members", 2)
	// A late watcher gets the members already known.
	e.hub.Watch(context.Background(), "mount", "sub/a.md")
	e.hub.Unwatch("mount", "sub/a.md")
	select {
	case f := <-c.in:
		if f.T == "join" || f.T == "leave" {
			t.Errorf("unexpected %s: the room is still watched", f.T)
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func TestRoomErrorClearsOnlyThatRoomUntilRefresh(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	e.hub.Watch(context.Background(), "v1", "b.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	c.next(t, "join")
	c.send(t, transport.PresenceFrame{T: "pong"}) // not an error
	c.send(t, transport.PresenceFrame{T: "error", Code: "forbidden", Room: &roomA})
	cl := e.rec.wait(t, "presence:cleared", 1).(Cleared)
	if cl.Path != "a.md" {
		t.Errorf("cleared = %+v", cl)
	}
	// The connection stays, the room is not joined again by itself...
	time.Sleep(150 * time.Millisecond)
	if n := e.srv.n.Load(); n != 1 {
		t.Fatalf("%d connections: the connection of the other room was dropped", n)
	}
	select {
	case f := <-c.in:
		if f.T == "join" {
			t.Fatal("the refused room was joined again")
		}
	default:
	}
	// ...until a Refresh (share_changed) enables it.
	e.hub.Refresh(context.Background())
	if f := c.next(t, "join"); *f.Room != roomA {
		t.Errorf("rejoined %+v", f.Room)
	}
}

func TestCloseCodes(t *testing.T) {
	e := newEnv(t, nil)
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	_ = c.ws.Close(4401, "token-expired") // new token, reconnect
	c2 := e.srv.accept(t)
	c2.next(t, "join")
	_ = c2.ws.Close(1013, "rate-limited") // reconnect, later
	c3 := e.srv.accept(t)
	c3.next(t, "join")
	_ = c3.ws.Close(4403, "user-suspended") // stop for this login
	time.Sleep(300 * time.Millisecond)
	select {
	case <-e.srv.conns:
		t.Fatal("reconnected for a suspended user")
	default:
	}
	e.hub.Refresh(context.Background())
	if w := e.hub.Watch(context.Background(), "v1", "b.md"); w.Watching {
		t.Error("watching while suspended")
	}
	e.client.Store(e.srv.client(t, 0)) // another login
	e.hub.Refresh(context.Background())
	e.srv.accept(t).next(t, "join")
}

// A file watched while Refresh is resolving the others is not suspended by it.
func TestRefreshLeavesAWatchBornDuringItAlone(t *testing.T) {
	var gate atomic.Pointer[chan struct{}]
	in := make(chan struct{}, 1)
	e := newEnv(t, func(o *Options) {
		inner := o.Resolve
		o.Resolve = func(ctx context.Context, v, p string) (string, string, string) {
			if g := gate.Load(); g != nil && p == "a.md" {
				in <- struct{}{}
				<-*g
			}
			return inner(ctx, v, p)
		}
	})
	e.hub.Watch(context.Background(), "v1", "a.md")
	c := e.srv.accept(t)
	c.next(t, "join")
	g := make(chan struct{})
	gate.Store(&g)
	done := make(chan struct{})
	go func() { e.hub.Refresh(context.Background()); close(done) }()
	<-in // Refresh is inside Resolve, outside the lock
	e.hub.Watch(context.Background(), "v1", "b.md")
	roomB := transport.PresenceRoom{Vault: "cloud-v1", File: "file-b.md"}
	if f := c.next(t, "join"); *f.Room != roomB {
		t.Fatalf("join %+v", f.Room)
	}
	close(g)
	<-done
	time.Sleep(100 * time.Millisecond)
	select {
	case f := <-c.in:
		if f.T == "leave" {
			t.Fatalf("Refresh suspended the watch born during it (leave %+v)", f.Room)
		}
	default:
	}
	if n := e.rec.count("presence:cleared"); n != 0 {
		t.Errorf("%d cleared events", n)
	}
}
