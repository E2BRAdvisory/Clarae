package presence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/httpserver"
	"clarae/services/cloud/internal/notify"
)

// fakeEnv stands in for the modules: tokens are "<name>" or "<name>:exp=<ms>".
type fakeEnv struct {
	mu        sync.Mutex
	users     map[string]uuid.UUID
	suspended map[string]bool
	disabled  map[uuid.UUID]bool
	denied    map[string]error // key user/file
	private   map[uuid.UUID]bool
	subs      map[uuid.UUID][]*notify.Sub
	hub       *notify.Hub
	slow      time.Duration // delay of CanView (tests of races)
}

func newFakeEnv() *fakeEnv {
	return &fakeEnv{users: map[string]uuid.UUID{}, suspended: map[string]bool{}, disabled: map[uuid.UUID]bool{},
		denied: map[string]error{}, private: map[uuid.UUID]bool{}, subs: map[uuid.UUID][]*notify.Sub{},
		hub: notify.NewHub(nil, zerolog.Nop())}
}

func (e *fakeEnv) user(name string) uuid.UUID {
	e.mu.Lock()
	defer e.mu.Unlock()
	if id, ok := e.users[name]; ok {
		return id
	}
	id := uuid.Must(uuid.NewV7())
	e.users[name] = id
	return id
}

func (e *fakeEnv) Authenticate(_ context.Context, raw string) (auth.Principal, time.Time, error) {
	name, expPart, _ := strings.Cut(raw, ":exp=")
	if name == "" || strings.HasPrefix(name, "bad") {
		return auth.Principal{}, time.Time{}, fmt.Errorf("%w: test", auth.ErrInvalidToken)
	}
	e.mu.Lock()
	sus := e.suspended[name]
	e.mu.Unlock()
	if sus {
		return auth.Principal{}, time.Time{}, auth.ErrSuspended
	}
	exp := time.Now().Add(time.Hour)
	if expPart != "" {
		var ms int
		_, _ = fmt.Sscan(expPart, &ms)
		exp = time.Now().Add(time.Duration(ms) * time.Millisecond)
	}
	return auth.Principal{UserID: e.user(name), Subject: name, Status: auth.StatusActive}, exp, nil
}

func (e *fakeEnv) DisplayName(_ context.Context, id uuid.UUID) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for n, u := range e.users {
		if u == id {
			return "Name of " + n, nil
		}
	}
	return "", errors.New("unknown")
}

func (e *fakeEnv) Enabled(_ context.Context, id uuid.UUID) (bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return !e.disabled[id], nil
}

func (e *fakeEnv) CanView(_ context.Context, id uuid.UUID, room Room) error {
	e.mu.Lock()
	slow := e.slow
	e.mu.Unlock()
	time.Sleep(slow)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.private[room.Vault] {
		return ErrEncrypted
	}
	return e.denied[id.String()+"/"+room.File.String()]
}

func (e *fakeEnv) Subscribe(user uuid.UUID) (*notify.Sub, func()) {
	s := e.hub.Subscribe(user)
	e.mu.Lock()
	e.subs[user] = append(e.subs[user], s)
	e.mu.Unlock()
	return s, func() { e.hub.Unsubscribe(s) }
}

func (e *fakeEnv) push(user uuid.UUID, ev notify.Event) {
	e.mu.Lock()
	subs := append([]*notify.Sub(nil), e.subs[user]...)
	e.mu.Unlock()
	for _, s := range subs {
		s.Push(ev)
	}
}

type harness struct {
	t   *testing.T
	env *fakeEnv
	hub *Hub
	srv *httptest.Server
}

func newHarness(t *testing.T, opts Options) *harness {
	t.Helper()
	env := newFakeEnv()
	hub := NewHub(zerolog.Nop(), nil)
	srv := httptest.NewServer(NewHandler(env, hub, zerolog.Nop(), opts))
	t.Cleanup(srv.Close)
	return &harness{t: t, env: env, hub: hub, srv: srv}
}

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func (h *harness) dial() *client {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.srv.URL, "http"), nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = ws.CloseNow() })
	return &client{t: h.t, ws: ws}
}

// login dials and authenticates as name, returning once ready arrived.
func (h *harness) login(token string) (*client, string) {
	h.t.Helper()
	c := h.dial()
	c.send(map[string]any{"t": "auth", "token": token})
	f := c.read()
	if f["t"] != "ready" {
		h.t.Fatalf("expected ready, got %v", f)
	}
	return c, f["sid"].(string)
}

func (c *client) send(v any) {
	c.t.Helper()
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, b); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *client) readErr(d time.Duration) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	_, data, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	var f map[string]any
	if err := json.Unmarshal(data, &f); err != nil {
		c.t.Fatalf("bad frame %q", data)
	}
	return f, nil
}

func (c *client) read() map[string]any {
	c.t.Helper()
	f, err := c.readErr(5 * time.Second)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return f
}

// closed waits for the connection to end and returns its close status.
func (c *client) closed() websocket.StatusCode {
	c.t.Helper()
	for {
		if _, err := c.readErr(5 * time.Second); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func roomJSON(r Room) map[string]any { return map[string]any{"vault": r.Vault, "file": r.File} }

func newRoom() Room { return Room{Vault: uuid.Must(uuid.NewV7()), File: uuid.Must(uuid.NewV7())} }

func (c *client) join(r Room) map[string]any {
	c.t.Helper()
	c.send(map[string]any{"t": "join", "room": roomJSON(r)})
	return c.read()
}

func TestFirstFrameAuthenticates(t *testing.T) {
	h := newHarness(t, Options{})
	c := h.dial()
	c.send(map[string]any{"t": "join", "room": roomJSON(newRoom())})
	if f := c.read(); f["t"] != "error" || f["code"] != CodeUnauth {
		t.Fatalf("frame before auth: %v", f)
	}
	if st := c.closed(); st != 4401 {
		t.Fatalf("close status %d", st)
	}

	c = h.dial()
	c.send(map[string]any{"t": "auth", "token": "bad-token"})
	if f := c.read(); f["code"] != CodeUnauth {
		t.Fatalf("bad token: %v", f)
	}
	if st := c.closed(); st != 4401 {
		t.Fatalf("close status %d", st)
	}

	h.env.mu.Lock()
	h.env.suspended["sus"] = true
	h.env.mu.Unlock()
	c = h.dial()
	c.send(map[string]any{"t": "auth", "token": "sus"})
	if f := c.read(); f["code"] != CodeSuspended {
		t.Fatalf("suspended: %v", f)
	}
	if st := c.closed(); st != 4403 {
		t.Fatalf("close status %d", st)
	}
}

func TestSilentConnectionTimesOut(t *testing.T) {
	h := newHarness(t, Options{AuthTimeout: 200 * time.Millisecond})
	c := h.dial()
	if st := c.closed(); st != 4401 {
		t.Fatalf("close status %d", st)
	}
}

func TestTokenExpiryClosesAndRenewalExtends(t *testing.T) {
	h := newHarness(t, Options{})
	c, _ := h.login("ann:exp=400")
	// Renew before it expires: the connection outlives the first token.
	c.send(map[string]any{"t": "auth", "token": "ann"})
	time.Sleep(600 * time.Millisecond)
	c.send(map[string]any{"t": "ping"})
	if f := c.read(); f["t"] != "pong" {
		t.Fatalf("after renewal: %v", f)
	}

	d, _ := h.login("bob:exp=300")
	if f := d.read(); f["t"] != "error" || f["code"] != CodeTokenExpired {
		t.Fatalf("expiry: %v", f)
	}
	if st := d.closed(); st != 4401 {
		t.Fatalf("close status %d", st)
	}

	// A renewal for another user is refused.
	e, _ := h.login("cy")
	e.send(map[string]any{"t": "auth", "token": "dave"})
	if f := e.read(); f["code"] != CodeUnauth {
		t.Fatalf("renewal as another user: %v", f)
	}
}

func TestPresenceDisabledForTheUser(t *testing.T) {
	h := newHarness(t, Options{})
	h.env.mu.Lock()
	h.env.disabled[h.env.userLocked("eve")] = true
	h.env.mu.Unlock()
	c := h.dial()
	c.send(map[string]any{"t": "auth", "token": "eve"})
	if f := c.read(); f["code"] != CodeDisabled {
		t.Fatalf("flag off: %v", f)
	}
	if st := c.closed(); st != 4403 {
		t.Fatalf("close status %d", st)
	}
}

func (e *fakeEnv) userLocked(name string) uuid.UUID {
	if id, ok := e.users[name]; ok {
		return id
	}
	id := uuid.Must(uuid.NewV7())
	e.users[name] = id
	return id
}

func TestFlagSwitchedOffWhileConnected(t *testing.T) {
	h := newHarness(t, Options{})
	c, _ := h.login("flo")
	uid := h.env.user("flo")
	h.env.mu.Lock()
	h.env.disabled[uid] = true
	h.env.mu.Unlock()
	h.env.push(uid, notify.Event{Kind: notify.KindConfig, Revision: 2})
	if f := c.read(); f["code"] != CodeDisabled {
		t.Fatalf("config change: %v", f)
	}
}

func TestJoinMembersMoveLeave(t *testing.T) {
	h := newHarness(t, Options{})
	a, sidA := h.login("ann")
	b, sidB := h.login("bob")
	room := newRoom()

	f := a.join(room)
	if f["t"] != "members" || len(f["list"].([]any)) != 1 {
		t.Fatalf("first members: %v", f)
	}
	f = b.join(room)
	list := f["list"].([]any)
	if f["t"] != "members" || len(list) != 2 {
		t.Fatalf("second members: %v", f)
	}
	var seen bool
	for _, m := range list {
		mm := m.(map[string]any)
		if mm["sid"] == sidA {
			seen = true
			if mm["name"] != "Name of ann" || mm["user_id"] != h.env.user("ann").String() {
				t.Fatalf("identity not stamped by the server: %v", mm)
			}
		}
	}
	if !seen {
		t.Fatalf("members lack ann: %v", list)
	}
	if f := a.read(); f["t"] != "joined" || f["member"].(map[string]any)["sid"] != sidB {
		t.Fatalf("ann expected joined bob: %v", f)
	}

	a.send(map[string]any{"t": "move", "room": roomJSON(room), "pos": map[string]any{"k": "text", "line": 3, "col": 7}})
	f = b.read()
	if f["t"] != "move" || f["sid"] != sidA || f["pos"].(map[string]any)["line"] != float64(3) {
		t.Fatalf("move: %v", f)
	}
	// The sender never gets its own position back.
	a.send(map[string]any{"t": "ping"})
	if f := a.read(); f["t"] != "pong" {
		t.Fatalf("own move echoed: %v", f)
	}

	b.send(map[string]any{"t": "leave", "room": roomJSON(room)})
	if f := a.read(); f["t"] != "left" || f["sid"] != sidB {
		t.Fatalf("left: %v", f)
	}
	// A client that closed leaves its rooms.
	a2, sidA2 := h.login("ann")
	a2.join(room)
	if f := a.read(); f["t"] != "joined" || f["member"].(map[string]any)["sid"] != sidA2 {
		t.Fatalf("joined: %v", f)
	}
	_ = a2.ws.Close(websocket.StatusNormalClosure, "")
	if f := a.read(); f["t"] != "left" || f["sid"] != sidA2 {
		t.Fatalf("left on close: %v", f)
	}
}

func TestJoinIsAuthorizedPerFile(t *testing.T) {
	h := newHarness(t, Options{})
	c, _ := h.login("ann")
	room := newRoom()
	h.env.mu.Lock()
	h.env.denied[h.env.userLocked("ann").String()+"/"+room.File.String()] = ErrNotFound
	h.env.mu.Unlock()
	f := c.join(room)
	if f["t"] != "error" || f["code"] != CodeNotFound || f["room"] == nil {
		t.Fatalf("denied file: %v", f)
	}
	// Another file of the same vault is fine, and the connection is still open.
	other := Room{Vault: room.Vault, File: uuid.Must(uuid.NewV7())}
	if f := c.join(other); f["t"] != "members" {
		t.Fatalf("allowed file: %v", f)
	}
	// A move in a room never joined is refused.
	c.send(map[string]any{"t": "move", "room": roomJSON(room), "pos": map[string]any{"k": "text"}})
	if f := c.read(); f["code"] != CodeNotJoined {
		t.Fatalf("move without join: %v", f)
	}
}

func TestPrivateVaultIsRefused(t *testing.T) {
	h := newHarness(t, Options{})
	c, _ := h.login("ann")
	room := newRoom()
	h.env.mu.Lock()
	h.env.private[room.Vault] = true
	h.env.mu.Unlock()
	if f := c.join(room); f["code"] != CodeEncrypted {
		t.Fatalf("private vault: %v", f)
	}
	if rooms, _ := h.hub.Stats(); rooms != 0 {
		t.Fatalf("a room was created for a private vault")
	}
}

func TestRevocationThrowsTheUserOut(t *testing.T) {
	h := newHarness(t, Options{})
	a, _ := h.login("ann")
	b, sidB := h.login("bob")
	room := newRoom()
	a.join(room)
	b.join(room)
	a.read() // joined bob

	uid := h.env.user("bob")
	h.env.mu.Lock()
	h.env.denied[uid.String()+"/"+room.File.String()] = ErrNotFound
	h.env.mu.Unlock()
	h.env.push(uid, notify.Event{Kind: notify.KindShare, ShareID: uuid.New(), ShareKind: notify.ShareRevoked})

	if f := b.read(); f["t"] != "error" || f["code"] != CodeForbidden || f["room"] == nil {
		t.Fatalf("revoked user: %v", f)
	}
	if f := a.read(); f["t"] != "left" || f["sid"] != sidB {
		t.Fatalf("others must see the user leave: %v", f)
	}
	// After the kick the user receives nothing from the room.
	a.send(map[string]any{"t": "move", "room": roomJSON(room), "pos": map[string]any{"k": "text"}})
	b.send(map[string]any{"t": "ping"})
	if f := b.read(); f["t"] != "pong" {
		t.Fatalf("revoked user still gets frames: %v", f)
	}
}

func TestPeriodicRecheckCatchesALostEvent(t *testing.T) {
	h := newHarness(t, Options{RecheckEvery: 100 * time.Millisecond})
	c, _ := h.login("ann")
	room := newRoom()
	c.join(room)
	h.env.mu.Lock()
	h.env.denied[h.env.userLocked("ann").String()+"/"+room.File.String()] = ErrNotFound
	h.env.mu.Unlock()
	if f := c.read(); f["code"] != CodeForbidden {
		t.Fatalf("recheck: %v", f)
	}
}

func TestSuspensionEventClosesTheConnection(t *testing.T) {
	h := newHarness(t, Options{})
	c, _ := h.login("ann")
	h.env.push(h.env.user("ann"), notify.Event{Kind: notify.KindAccount, AccountKind: notify.AccountSuspended})
	if f := c.read(); f["code"] != CodeSuspended {
		t.Fatalf("suspension: %v", f)
	}
	if st := c.closed(); st != 4403 {
		t.Fatalf("close status %d", st)
	}
}

func TestLimits(t *testing.T) {
	h := newHarness(t, Options{})
	c, _ := h.login("ann")

	// Rooms per connection.
	for i := 0; i < MaxRoomsPerConn; i++ {
		if f := c.join(newRoom()); f["t"] != "members" {
			t.Fatalf("room %d: %v", i, f)
		}
	}
	over := newRoom()
	if f := c.join(over); f["code"] != CodeTooManyRooms {
		t.Fatalf("17th room: %v", f)
	}

	// An oversized position.
	room := newRoom()
	d, _ := h.login("bob")
	d.join(room)
	d.send(map[string]any{"t": "move", "room": roomJSON(room), "pos": map[string]any{"k": "text", "pad": strings.Repeat("x", 300)}})
	if f := d.read(); f["code"] != CodeTooLarge {
		t.Fatalf("pos > 256 B: %v", f)
	}

	// A frame over 1 KiB closes the connection.
	e, _ := h.login("cy")
	e.send(map[string]any{"t": "ping", "pad": strings.Repeat("x", 2000)})
	if f := e.read(); f["code"] != CodeTooLarge {
		t.Fatalf("frame > 1 KiB: %v", f)
	}
	if st := e.closed(); st != websocket.StatusMessageTooBig {
		t.Fatalf("close status %d", st)
	}

	// Unknown frames are refused without closing.
	f1, _ := h.login("dee")
	f1.send(map[string]any{"t": "nope"})
	if f := f1.read(); f["code"] != CodeBadFrame {
		t.Fatalf("unknown frame: %v", f)
	}
	f1.send(map[string]any{"t": "ping"})
	if f := f1.read(); f["t"] != "pong" {
		t.Fatalf("connection must survive: %v", f)
	}
}

func TestConnectionsPerUser(t *testing.T) {
	h := newHarness(t, Options{})
	for i := 0; i < MaxConnsPerUser; i++ {
		h.login("ann")
	}
	c := h.dial()
	c.send(map[string]any{"t": "auth", "token": "ann"})
	if f := c.read(); f["code"] != CodeTooManyConns {
		t.Fatalf("33rd connection: %v", f)
	}
	if st := c.closed(); st != websocket.StatusTryAgainLater {
		t.Fatalf("close status %d", st)
	}
	// Another user is not affected.
	h.login("bob")
}

func TestMoveFloodIsCoalescedAndTheLastPositionArrives(t *testing.T) {
	h := newHarness(t, Options{})
	a, _ := h.login("ann")
	b, _ := h.login("bob")
	room := newRoom()
	a.join(room)
	b.join(room)
	a.read() // joined

	const n = 300
	for i := 1; i <= n; i++ {
		a.send(map[string]any{"t": "move", "room": roomJSON(room), "pos": map[string]any{"k": "text", "line": i, "col": 0}})
	}
	got, last := 0, 0.0
	deadline := time.Now().Add(3 * time.Second)
	for last != n && time.Now().Before(deadline) {
		f, err := b.readErr(time.Second)
		if err != nil {
			break
		}
		if f["t"] == "move" {
			got++
			last = f["pos"].(map[string]any)["line"].(float64)
		}
	}
	if last != n {
		t.Fatalf("the latest position never arrived (last %v after %d frames)", last, got)
	}
	if got >= n/2 {
		t.Fatalf("%d of %d moves were relayed: no coalescing", got, n)
	}
}

func TestDrainClosesWithGoingAway(t *testing.T) {
	env := newFakeEnv()
	hub := NewHub(zerolog.Nop(), nil)
	drain := httpserver.NewDrain()
	srv := httptest.NewServer(drain.Streams(NewHandler(env, hub, zerolog.Nop(), Options{})))
	t.Cleanup(srv.Close)
	h := &harness{t: t, env: env, hub: hub, srv: srv}
	c, _ := h.login("ann")
	c.join(newRoom())
	drain.Close()
	if st := c.closed(); st != websocket.StatusGoingAway {
		t.Fatalf("close status %d", st)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rooms, conns := hub.Stats(); rooms == 0 && conns == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the room was not emptied after the drain")
}

// A join of a room the connection is already in must not bring it back after a
// concurrent recheck threw it out: the answer comes only from the live membership.
func TestJoinCannotUndoARevocation(t *testing.T) {
	h := newHarness(t, Options{RecheckEvery: 50 * time.Millisecond})
	c, _ := h.login("ann")
	room := newRoom()
	c.join(room)
	h.env.mu.Lock()
	h.env.denied[h.env.userLocked("ann").String()+"/"+room.File.String()] = ErrNotFound
	h.env.slow = 150 * time.Millisecond
	h.env.mu.Unlock()
	for i := 0; i < 8; i++ {
		c.send(map[string]any{"t": "join", "room": roomJSON(room)})
		time.Sleep(40 * time.Millisecond)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := c.readErr(200 * time.Millisecond); err != nil {
			break
		}
	}
	time.Sleep(400 * time.Millisecond)
	if rooms, _ := h.hub.Stats(); rooms != 0 {
		t.Fatalf("the revoked user is back in %d room(s)", rooms)
	}
}

func TestCommitRechecksTheRoomsOfThatVault(t *testing.T) {
	h := newHarness(t, Options{VaultRecheckEvery: 50 * time.Millisecond})
	c, _ := h.login("ann")
	room := newRoom()
	c.join(room)
	uid := h.env.user("ann")
	h.env.mu.Lock()
	h.env.denied[uid.String()+"/"+room.File.String()] = ErrNotFound
	h.env.mu.Unlock()
	h.env.push(uid, notify.Event{VaultID: uuid.New(), Seq: 1}) // another vault: nothing
	h.env.push(uid, notify.Event{VaultID: room.Vault, Seq: 2})
	if f := c.read(); f["code"] != CodeForbidden || f["room"] == nil {
		t.Fatalf("file moved out of the share: %v", f)
	}
}
