//go:build integration

package integration

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"clarae/services/cloud/internal/auth/authtest"
	"clarae/services/cloud/internal/grpcserver"
	"clarae/services/cloud/internal/httpserver"
	"clarae/services/cloud/internal/system"
	"clarae/shared/notifyv1"
)

// auditIP returns the address stored for the newest audit row of action on target.
func (e *env) auditIP(action, target string) string {
	e.t.Helper()
	var ip *string
	err := e.db.Pool.QueryRow(context.Background(),
		"SELECT host(ip) FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id DESC LIMIT 1", action, target).Scan(&ip)
	if err != nil {
		e.t.Fatalf("audit row %s %s: %v", action, target, err)
	}
	if ip == nil {
		return ""
	}
	return *ip
}

// proxiedRouter serves the same application behind a router that trusts the
// loopback as a reverse proxy, the way a deployment behind ingress does.
func (e *env) proxiedRouter(trusted ...netip.Prefix) string {
	e.t.Helper()
	router := httpserver.NewRouter(e.app.FillDeps(httpserver.Deps{
		Logger:         zerolog.Nop(),
		Auth:           e.authn,
		System:         system.NewHTTP("test", system.ClientConfig{}),
		TrustedProxies: trusted,
	}))
	srv := httptest.NewServer(router)
	e.t.Cleanup(srv.Close)
	return srv.URL + httpserver.BasePath
}

func postJSON(t *testing.T, url, token string, body any, headers map[string]string) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestAuditRecordsClientIP(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	spoof := map[string]string{"X-Forwarded-For": "198.51.100.66"}

	// Direct connection: the TCP peer is the client and a client-supplied
	// X-Forwarded-For is not believed.
	resp := postJSON(t, e.baseURL+"/admin/users", root.token, map[string]any{"username": "ipdirect", "role": "user", "display_name": "IP direct", "email": "ipdirect-" + newID()[:8] + "@clarae.local"}, spoof)
	expect(t, resp, http.StatusCreated)
	direct := decode[adminUser](t, resp)
	if got := e.auditIP("user.create", direct.ID); got != "127.0.0.1" {
		t.Fatalf("direct: ip %q, want 127.0.0.1", got)
	}

	// Behind a trusted proxy: the rightmost untrusted hop is the client; the
	// entries further left were supplied by the client and are ignored.
	base := e.proxiedRouter(netip.MustParsePrefix("127.0.0.1/32"))
	resp = postJSON(t, base+"/admin/users", root.token, map[string]any{"username": "ipproxied", "role": "user", "display_name": "IP proxied", "email": "ipproxied-" + newID()[:8] + "@clarae.local"},
		map[string]string{"X-Forwarded-For": "198.51.100.66, 203.0.113.7"})
	expect(t, resp, http.StatusCreated)
	proxied := decode[adminUser](t, resp)
	if got := e.auditIP("user.create", proxied.ID); got != "203.0.113.7" {
		t.Fatalf("proxied: ip %q, want 203.0.113.7", got)
	}

	// The admin API surfaces it.
	resp = root.json(http.MethodGet, "/admin/audit-log?target="+proxied.ID, nil)
	expect(t, resp, http.StatusOK)
	page := decode[struct {
		Items []struct {
			Action string `json:"action"`
			IP     string `json:"ip"`
		} `json:"items"`
	}](t, resp)
	if len(page.Items) == 0 || page.Items[0].IP != "203.0.113.7" {
		t.Fatalf("audit page: %+v", page.Items)
	}
}

func TestVaultLifecycleIsAudited(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createPrivateVault("Audited " + newID()[:8])

	expect(t, ada.json(http.MethodPut, "/vaults/"+v+"/key-envelopes/passphrase", envelopes()[0]), http.StatusOK)
	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)
	expect(t, ada.json(http.MethodPost, "/vaults/"+v+":restore", nil), http.StatusOK)

	rows, err := e.db.Pool.Query(context.Background(),
		"SELECT action, actor_id::text, COALESCE(host(ip), ''), COALESCE(details::text, '') FROM audit_log WHERE target_type = 'vault' AND target_id = $1", v)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]string{}
	for rows.Next() {
		var action, actor, ip, details string
		if err := rows.Scan(&action, &actor, &ip, &details); err != nil {
			t.Fatal(err)
		}
		if actor != ada.userID || ip != "127.0.0.1" {
			t.Fatalf("%s: actor %s ip %q", action, actor, ip)
		}
		got[action] = details
	}
	for _, a := range []string{"vault.delete", "vault.restore", "vault.envelope.replace"} {
		if _, ok := got[a]; !ok {
			t.Fatalf("missing audit action %s (have %v)", a, got)
		}
	}
	if d := got["vault.envelope.replace"]; !strings.Contains(d, `"passphrase"`) || strings.Contains(d, "wrapped") || strings.Contains(d, "salt") {
		t.Fatalf("envelope details must name the kind only: %s", d)
	}
}

func TestAuditCSVNeutralisesActorName(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	// The username comes from the identity provider's preferred_username.
	evil := &client{e: e, token: e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-evil-" + newID(), Username: `=HYPERLINK("http://evil.example")`, Email: "evil-" + newID()[:8] + "@clarae.local"})}
	evil.userID, _ = decode[map[string]any](t, evil.json(http.MethodGet, "/me", nil))["id"].(string)
	v := evil.createVault("CSV "+newID()[:8], "shared")
	expect(t, evil.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)

	resp := root.json(http.MethodGet, "/admin/audit-log.csv?target="+v, nil)
	expect(t, resp, http.StatusOK)
	rows, err := csv.NewReader(resp.Body).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[1][4] != "vault.delete" {
		t.Fatalf("csv rows: %q", rows)
	}
	if actor := rows[1][3]; actor != `'=HYPERLINK("http://evil.example")` {
		t.Fatalf("actor cell %q not neutralised", actor)
	}
}

// sseLines streams the lines of an SSE response; the channel closes at EOF.
func sseLines(body interface{ Read([]byte) (int, error) }) <-chan string {
	lines := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	return lines
}

func TestSSEStreamEndsOnSuspension(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	u := e.user("sse-suspended")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.server.URL+"/api/v1/events?config=1073741824", nil)
	req.Header.Set("Authorization", "Bearer "+u.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	expect(t, resp, http.StatusOK)
	lines := sseLines(resp.Body)
	next := func() (string, bool) {
		select {
		case l, ok := <-lines:
			return l, ok
		case <-ctx.Done():
			t.Fatal("timeout reading the stream")
			return "", false
		}
	}
	if l, _ := next(); l != ": connected" {
		t.Fatalf("first line %q", l)
	}

	expect(t, root.json(http.MethodPost, "/admin/users/"+u.userID+":suspend", nil), http.StatusOK)

	sawSuspension := false
	for {
		l, ok := next()
		if !ok {
			break // the server closed the stream
		}
		if l == `data: {"kind":"suspended"}` {
			sawSuspension = true
		}
	}
	if !sawSuspension {
		t.Fatal("the stream closed without the account_changed event")
	}
}

func TestGRPCStreamEndsOnSuspension(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	u := e.user("grpc-suspended")
	v := u.createVault("GRPC "+newID()[:8], "shared")
	mustAccepted(t, u.commit(v, create(newID(), "one.md", u.putBlob(v, []byte("x"))))[0])

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpcserver.New(e.authn, e.app.Hub)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	ctx, cancel := context.WithTimeout(metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer "+u.token), 15*time.Second)
	defer cancel()
	stream, err := notifyv1.NewNotifyServiceClient(conn).Subscribe(ctx, &notifyv1.SubscribeRequest{KnownSeq: map[string]int64{v: 0}, ConfigVersion: 1 << 30})
	if err != nil {
		t.Fatal(err)
	}
	// The replay proves the subscription is registered before the suspension.
	if ev, err := stream.Recv(); err != nil || ev.GetVaultChanged().GetVaultId() != v {
		t.Fatalf("replay: %v %v", ev, err)
	}

	expect(t, root.json(http.MethodPost, "/admin/users/"+u.userID+":suspend", nil), http.StatusOK)

	sawSuspension := false
	for {
		ev, err := stream.Recv()
		if err != nil {
			if status.Code(err) != codes.PermissionDenied {
				t.Fatalf("stream ended with %v, want PERMISSION_DENIED", err)
			}
			break
		}
		if ev.GetAccountChanged().GetKind() == "suspended" {
			sawSuspension = true
		}
	}
	if !sawSuspension {
		t.Fatal("the stream closed without the account_changed event")
	}
}
