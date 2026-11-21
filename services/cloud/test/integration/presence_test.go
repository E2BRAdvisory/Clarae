//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"clarae/services/cloud/internal/configprofiles"
	"clarae/services/cloud/internal/presence"
)

type wsClient struct {
	t  *testing.T
	ws *websocket.Conn
}

// presenceDial opens the presence WebSocket on a server and authenticates with its first frame.
func presenceDial(t *testing.T, baseURL, token string) (*wsClient, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(baseURL, "http")+"/api/v1/presence", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	c := &wsClient{t: t, ws: ws}
	c.send(map[string]any{"t": "auth", "token": token})
	f := c.read()
	if f["t"] != "ready" {
		return c, f["code"].(string)
	}
	return c, ""
}

func (c *wsClient) send(v any) {
	c.t.Helper()
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, b); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *wsClient) read() map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.ws.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	var f map[string]any
	_ = json.Unmarshal(data, &f)
	return f
}

// until reads frames until one has type typ, failing after a few seconds.
func (c *wsClient) until(typ string) map[string]any {
	c.t.Helper()
	for i := 0; i < 50; i++ {
		if f := c.read(); f["t"] == typ {
			return f
		}
	}
	c.t.Fatalf("no %q frame", typ)
	return nil
}

func (c *wsClient) join(vault, file string) map[string]any {
	c.t.Helper()
	c.send(map[string]any{"t": "join", "room": map[string]any{"vault": vault, "file": file}})
	// Frames about other members may come first: the answer is the members or error frame.
	for i := 0; i < 20; i++ {
		if f := c.read(); f["t"] == "members" || f["t"] == "error" {
			return f
		}
	}
	c.t.Fatal("no answer to join")
	return nil
}

func TestPresenceAuthorizationThroughShares(t *testing.T) {
	e, ada, bob, carol, vault, ids, _ := sharedFixture(t)
	sh := ada.share(vault, "folder", "Projects/Alfa", grantTo("user", bob.userID, "viewer"))
	bob.accept(sh.id())
	plan, beta := ids["Projects/Alfa/plan.md"], ids["Projects/Beta/x.md"]

	a, _ := presenceDial(t, e.server.URL, ada.token)
	if f := a.join(vault, beta); f["t"] != "members" {
		t.Fatalf("the owner reaches every file: %v", f)
	}
	if f := a.join(vault, plan); f["t"] != "members" {
		t.Fatalf("owner, plan: %v", f)
	}
	b, _ := presenceDial(t, e.server.URL, bob.token)
	if f := b.join(vault, plan); f["t"] != "members" {
		t.Fatalf("a viewer reaches a file of the share: %v", f)
	}
	if f := b.join(vault, beta); f["t"] != "error" || f["code"] != "not-found" {
		t.Fatalf("a file outside the share: %v", f)
	}
	c, _ := presenceDial(t, e.server.URL, carol.token)
	if f := c.join(vault, plan); f["code"] != "not-found" {
		t.Fatalf("a stranger: %v", f)
	}
	if f := c.join(vault, uuid.NewString()); f["code"] != "not-found" {
		t.Fatalf("an unknown file: %v", f)
	}

	// A private vault has no presence, for its owner and for everybody else.
	pv := ada.createPrivateVault("Secret")
	if f := a.join(pv, newID()); f["code"] != "vault-encrypted" {
		t.Fatalf("private vault, owner: %v", f)
	}
	if f := c.join(pv, newID()); f["code"] != "not-found" {
		t.Fatalf("private vault, stranger: %v", f)
	}

	// Revoking the share throws bob out of the room, through the real notification path.
	expect(t, ada.json(http.MethodDelete, "/shares/"+sh.id(), nil), http.StatusNoContent)
	f := b.until("error")
	if f["code"] != "forbidden" || f["room"] == nil {
		t.Fatalf("after the revocation: %v", f)
	}
}

func TestPresenceFlagOffInTheProfile(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	ctx := context.Background()
	p, err := e.app.Config.Create(ctx, ada.uid(), configprofiles.ProfileInput{Name: "NoPresence " + newID(), IsGlobal: true, Config: json.RawMessage(`{"features":{"presence":false}}`)})
	if err != nil {
		t.Fatal(err)
	}
	// The database is shared by the tests of the package: do not leave a global profile behind.
	t.Cleanup(func() { _ = e.app.Config.Delete(ctx, ada.uid(), p.ID) })
	if _, code := presenceDial(t, e.server.URL, bob.token); code != "presence-disabled" {
		t.Fatalf("flag off: %q", code)
	}
}

func TestPresenceRejectsABadToken(t *testing.T) {
	e := newEnv(t)
	if _, code := presenceDial(t, e.server.URL, "not-a-jwt"); code != "unauthenticated" {
		t.Fatalf("bad token: %q", code)
	}
}

// Two replicas on the same PostgreSQL: members and positions cross over the channel "presence".
func TestPresenceFansOutBetweenReplicas(t *testing.T) {
	e, ada, bob, _, vault, ids, _ := sharedFixture(t)
	sh := ada.share(vault, "vault", "", grantTo("user", bob.userID, "editor"))
	bob.accept(sh.id())
	plan := ids["Projects/Alfa/plan.md"]

	second := presence.NewService(e.db, zerolog.Nop(), e.app.Sharing, e.app.Config, e.app.Hub)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = second.Run(ctx) }()
	// The second replica serves the same route on its own server.
	mux := http.NewServeMux()
	mux.Handle("/api/v1/presence", second.Handler(e.authn, presence.Options{}))
	srv2b := httptest.NewServer(mux)
	t.Cleanup(srv2b.Close)

	a, sidA := presenceDial(t, e.server.URL, ada.token) // replica 1
	if sidA != "" {
		t.Fatalf("replica 1: %q", sidA)
	}
	if f := a.join(vault, plan); f["t"] != "members" {
		t.Fatalf("a: %v", f)
	}
	// Give the listener of replica 2 the join of ada before bob arrives: it is announced at once.
	time.Sleep(500 * time.Millisecond)

	b, code := presenceDial(t, srv2b.URL, bob.token) // replica 2
	if code != "" {
		t.Fatalf("replica 2: %q", code)
	}
	f := b.join(vault, plan)
	if f["t"] != "members" || len(f["list"].([]any)) != 2 {
		t.Fatalf("bob on replica 2 must see ada on replica 1: %v", f)
	}
	joined := a.until("joined")
	if joined["member"].(map[string]any)["user_id"] != bob.userID {
		t.Fatalf("ada must see bob: %v", joined)
	}

	// Positions travel in both directions, and not back to their sender.
	a.send(map[string]any{"t": "move", "room": map[string]any{"vault": vault, "file": plan}, "pos": map[string]any{"k": "text", "line": 4, "col": 2}})
	m := b.until("move")
	if m["pos"].(map[string]any)["line"] != float64(4) {
		t.Fatalf("move to replica 2: %v", m)
	}
	b.send(map[string]any{"t": "move", "room": map[string]any{"vault": vault, "file": plan}, "pos": map[string]any{"k": "text", "line": 9, "col": 1}})
	m = a.until("move")
	if m["pos"].(map[string]any)["line"] != float64(9) {
		t.Fatalf("move to replica 1: %v", m)
	}

	// Leaving crosses over too.
	_ = b.ws.Close(websocket.StatusNormalClosure, "")
	if l := a.until("left"); l["sid"] == nil {
		t.Fatalf("left: %v", l)
	}
}
