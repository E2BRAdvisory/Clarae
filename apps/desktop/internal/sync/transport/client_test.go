package transport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"memobrain/shared/syncproto"
)

// The tests run the client against an in-process RoundTripper rather than a
// listening server, so they also run under js/wasm (the browser core).

type staticTokens string

func (s staticTokens) Token(context.Context) (string, error) { return string(s), nil }

type recorded struct {
	method, path, query string
	header              http.Header
	body                string
}

// fakeServer answers each request with the next of its handlers (the last one repeats).
type fakeServer struct {
	mu       sync.Mutex
	handlers []func(*http.Request) *http.Response
	reqs     []recorded
}

func (f *fakeServer) RoundTrip(r *http.Request) (*http.Response, error) {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
	}
	f.mu.Lock()
	f.reqs = append(f.reqs, recorded{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, header: r.Header.Clone(), body: string(body)})
	h := f.handlers[min(len(f.reqs), len(f.handlers))-1]
	f.mu.Unlock()
	resp := h(r)
	resp.Request = r
	return resp, nil
}

func reply(status int, contentType, body string) func(*http.Request) *http.Response {
	return func(*http.Request) *http.Response {
		h := http.Header{}
		if contentType != "" {
			h.Set("Content-Type", contentType)
		}
		return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}
	}
}

func problem(status int, code syncproto.Code) func(*http.Request) *http.Response {
	return reply(status, "application/problem+json", `{"type":"about:blank","title":"x","status":`+strconv.Itoa(status)+`,"code":"`+string(code)+`","detail":"d","request_id":"rid"}`)
}

func newTestClient(t *testing.T, f *fakeServer) *Client {
	t.Helper()
	c, err := New("https://cloud.example", staticTokens("tok"), &http.Client{Transport: f}, "test-agent")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

const vaultJSON = `{"id":"0190a0a0-0000-7000-8000-000000000001","owner_id":"0190a0a0-0000-7000-8000-000000000002","name":"Notes","kind":"shared","last_seq":3,"total_bytes":10,"file_count":1,"created_at":"2026-01-02T03:04:05Z"}`

// A retried POST must carry the same Idempotency-Key on every attempt, or the
// server cannot recognize the retry (each attempt gets its own request id).
func TestRetriedPostReusesIdempotencyKey(t *testing.T) {
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{
		reply(http.StatusServiceUnavailable, "", "busy"),
		reply(http.StatusBadGateway, "", "busy"),
		reply(http.StatusCreated, "application/json", vaultJSON),
	}}
	c := newTestClient(t, f)
	v, err := c.CreateVault(context.Background(), "Notes", "shared", nil)
	if err != nil {
		t.Fatal(err)
	}
	if v.Name != "Notes" || v.Id.String() != "0190a0a0-0000-7000-8000-000000000001" {
		t.Fatalf("vault: %+v", v)
	}
	if len(f.reqs) != 3 {
		t.Fatalf("attempts: %d", len(f.reqs))
	}
	key := f.reqs[0].header.Get("Idempotency-Key")
	if key == "" {
		t.Fatal("no Idempotency-Key")
	}
	ids := map[string]bool{}
	for i, r := range f.reqs {
		if got := r.header.Get("Idempotency-Key"); got != key {
			t.Fatalf("attempt %d: Idempotency-Key %q, want %q", i, got, key)
		}
		if r.body != `{"kind":"shared","name":"Notes"}` {
			t.Fatalf("attempt %d: body %q", i, r.body)
		}
		ids[r.header.Get("X-Request-Id")] = true
		if r.header.Get("Authorization") != "Bearer tok" || r.header.Get("User-Agent") != "test-agent" {
			t.Fatalf("attempt %d: headers %v", i, r.header)
		}
	}
	if len(ids) != 3 {
		t.Fatalf("request ids are not per attempt: %v", ids)
	}

	// The next logical operation gets a new key.
	f.handlers = []func(*http.Request) *http.Response{reply(http.StatusCreated, "application/json", vaultJSON)}
	if _, err := c.CreateVault(context.Background(), "Notes", "shared", nil); err != nil {
		t.Fatal(err)
	}
	if got := f.reqs[3].header.Get("Idempotency-Key"); got == "" || got == key {
		t.Fatalf("second operation reused key %q", got)
	}
}

func TestCommitIdempotencyKeyAndConversion(t *testing.T) {
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{
		problem(http.StatusTooManyRequests, syncproto.CodeRateLimited),
		reply(http.StatusOK, "application/json", `{"last_seq":7,"results":[{"op_id":"0190a0a0-0000-7000-8000-00000000000a","status":"conflict","code":"REV_CONFLICT","current_rev":4,"current_hash":"`+strings.Repeat("a", 64)+`"}]}`),
	}}
	c := newTestClient(t, f)
	c.Retries = 1
	base := 3
	res, err := c.Commit(context.Background(), Ref("0190a0a0-0000-7000-8000-000000000001", "share:0190a0a0-0000-7000-8000-000000000003"), syncproto.CommitRequest{
		DeviceID: "0190a0a0-0000-7000-8000-000000000004",
		Ops:      []syncproto.Op{{OpID: "0190a0a0-0000-7000-8000-00000000000a", Op: syncproto.OpModify, FileID: "0190a0a0-0000-7000-8000-00000000000b", BaseRev: &base, BlobHash: strings.Repeat("b", 64), Size: 5}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.LastSeq != 7 || len(res.Results) != 1 || res.Results[0].Status != syncproto.StatusConflict || res.Results[0].Code != syncproto.CodeRevConflict || res.Results[0].CurrentRev != 4 {
		t.Fatalf("result: %+v", res)
	}
	if len(f.reqs) != 2 || f.reqs[0].header.Get("Idempotency-Key") == "" || f.reqs[0].header.Get("Idempotency-Key") != f.reqs[1].header.Get("Idempotency-Key") {
		t.Fatalf("idempotency key not reused: %v / %v", f.reqs[0].header, f.reqs[1].header)
	}
	r := f.reqs[1]
	if r.path != "/api/v1/vaults/0190a0a0-0000-7000-8000-000000000001/commit" || r.query != "scope=share%3A0190a0a0-0000-7000-8000-000000000003" {
		t.Fatalf("request %s?%s", r.path, r.query)
	}
	want := `{"device_id":"0190a0a0-0000-7000-8000-000000000004","ops":[{"base_rev":3,"blob_hash":"` + strings.Repeat("b", 64) + `","file_id":"0190a0a0-0000-7000-8000-00000000000b","op":"modify","op_id":"0190a0a0-0000-7000-8000-00000000000a","size":5}]}`
	if r.body != want {
		t.Fatalf("body\n got %s\nwant %s", r.body, want)
	}
}

func TestProblemDecoding(t *testing.T) {
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{problem(http.StatusGone, syncproto.CodeCursorExpired)}}
	c := newTestClient(t, f)
	_, err := c.GetChanges(context.Background(), "0190a0a0-0000-7000-8000-000000000001", 5, "", 0)
	var pe *ProblemError
	if !errors.As(err, &pe) || pe.StatusCode != http.StatusGone || pe.Problem.Code != syncproto.CodeCursorExpired || pe.Problem.RequestID != "rid" || pe.Problem.Detail != "d" {
		t.Fatalf("err: %#v", err)
	}
	if !IsCode(err, syncproto.CodeCursorExpired) || !errors.Is(err, CodeError(syncproto.CodeCursorExpired)) {
		t.Fatal("code matching")
	}
	if len(f.reqs) != 1 || f.reqs[0].query != "since=5" {
		t.Fatalf("requests: %+v", f.reqs)
	}

	// A body that is not a problem still yields a code; exhausted retries return the last answer.
	f = &fakeServer{handlers: []func(*http.Request) *http.Response{reply(http.StatusBadGateway, "text/html", "<html>bad gateway</html>")}}
	c = newTestClient(t, f)
	c.Retries = 0
	_, err = c.ListVaults(context.Background())
	if !errors.As(err, &pe) || pe.StatusCode != http.StatusBadGateway || pe.Problem.Code != syncproto.CodeInternal || strings.Contains(err.Error(), "html") {
		t.Fatalf("err: %#v", err)
	}
}

// An answer without a problem document (a reverse proxy in front of the
// server) gets its code from the status, and its body, an HTML page as often
// as not, never reaches the error the user sees.
func TestNonProblemAnswersGetACodeFromTheStatus(t *testing.T) {
	page := "<html><head><title>nginx</title></head><body>" + strings.Repeat("x", 4096) + "</body></html>"
	cases := []struct {
		status int
		code   syncproto.Code
	}{
		{http.StatusUnauthorized, syncproto.CodeUnauthenticated},
		{http.StatusForbidden, syncproto.CodeForbidden},
		{http.StatusNotFound, syncproto.CodeInternal}, // only the server knows that a vault is gone
		{http.StatusRequestEntityTooLarge, syncproto.CodeFileTooLarge},
		{http.StatusTooManyRequests, syncproto.CodeRateLimited},
		{http.StatusBadGateway, syncproto.CodeInternal},
		{http.StatusServiceUnavailable, syncproto.CodeInternal},
		{http.StatusGatewayTimeout, syncproto.CodeInternal},
	}
	for _, tc := range cases {
		t.Run(strconv.Itoa(tc.status), func(t *testing.T) {
			f := &fakeServer{handlers: []func(*http.Request) *http.Response{func(r *http.Request) *http.Response {
				resp := reply(tc.status, "text/html", page)(r)
				resp.Header.Set("Retry-After", "7")
				return resp
			}}}
			c := newTestClient(t, f)
			c.Retries = 0
			_, err := c.ListVaults(context.Background())
			var pe *ProblemError
			if !errors.As(err, &pe) || pe.StatusCode != tc.status || pe.Problem.Code != tc.code {
				t.Fatalf("err: %#v", err)
			}
			if msg := err.Error(); strings.Contains(msg, "<") || strings.Contains(msg, "nginx") || len(msg) > 200 {
				t.Fatalf("the body leaks into the error: %q", msg)
			}
			if pe.Problem.Extra["retry_after"] != "7" {
				t.Fatalf("retry_after: %v", pe.Problem.Extra)
			}
		})
	}

	// The same through a blob upload: the push parks the file on FILE_TOO_LARGE.
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{reply(http.StatusRequestEntityTooLarge, "text/html", page)}}
	c := newTestClient(t, f)
	err := c.PutBlob(context.Background(), testVaultID, testBlobHash, []byte("data"))
	if !IsCode(err, syncproto.CodeFileTooLarge) || strings.Contains(err.Error(), "nginx") {
		t.Fatalf("err: %v", err)
	}
}

const (
	testVaultID  = "0190a0a0-0000-7000-8000-000000000001"
	testBlobHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

// rotatingTokens hands out tok-1, and tok-2 once tok-1 was invalidated; with
// stuck it cannot renew (a token from a host page).
type rotatingTokens struct {
	mu          sync.Mutex
	n           int
	stuck       bool
	invalidated []string
}

func (r *rotatingTokens) Token(context.Context) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return "tok-" + strconv.Itoa(r.n+1), nil
}

func (r *rotatingTokens) InvalidateToken(tok string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.invalidated = append(r.invalidated, tok)
	if !r.stuck && tok == "tok-"+strconv.Itoa(r.n+1) {
		r.n++
	}
}

// A 401 drops the token and the request goes again, once, with a new one; a
// second 401 is the answer. A source that cannot renew is not asked twice.
func TestUnauthorizedRenewsTheTokenOnce(t *testing.T) {
	unauthorized := reply(http.StatusUnauthorized, "application/problem+json", `{"type":"x","title":"x","status":401,"code":"UNAUTHENTICATED"}`)
	ok := reply(http.StatusOK, "application/json", `{"items":[]}`)
	newClient := func(f *fakeServer, tokens TokenSource) *Client {
		c, err := New("https://cloud.example", tokens, &http.Client{Transport: f}, "test-agent")
		if err != nil {
			t.Fatal(err)
		}
		return c
	}

	tokens := &rotatingTokens{}
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{unauthorized, ok}}
	if _, err := newClient(f, tokens).ListVaults(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.reqs) != 2 || f.reqs[0].header.Get("Authorization") != "Bearer tok-1" || f.reqs[1].header.Get("Authorization") != "Bearer tok-2" {
		t.Fatalf("requests: %+v", f.reqs)
	}

	tokens = &rotatingTokens{}
	f = &fakeServer{handlers: []func(*http.Request) *http.Response{unauthorized}}
	if _, err := newClient(f, tokens).ListVaults(context.Background()); !IsCode(err, syncproto.CodeUnauthenticated) {
		t.Fatalf("err: %v", err)
	}
	if len(f.reqs) != 2 {
		t.Fatalf("a refused new token must not be retried: %d requests", len(f.reqs))
	}

	tokens = &rotatingTokens{stuck: true}
	f = &fakeServer{handlers: []func(*http.Request) *http.Response{unauthorized}}
	if _, err := newClient(f, tokens).ListVaults(context.Background()); !IsCode(err, syncproto.CodeUnauthenticated) {
		t.Fatalf("err: %v", err)
	}
	if len(f.reqs) != 1 || len(tokens.invalidated) != 1 {
		t.Fatalf("requests %d, invalidated %v", len(f.reqs), tokens.invalidated)
	}
}

// A JSON answer larger than MaxResponseBytes fails the call, whether it says
// so in Content-Length or not; one of exactly the limit is read.
func TestJSONResponsesAreBounded(t *testing.T) {
	body := `{"items":[]}`
	for _, tc := range []struct {
		name    string
		limit   int64
		length  int64
		tooLong bool
	}{
		{"chunked over", int64(len(body)) - 1, -1, true},
		{"declared over", int64(len(body)) - 1, int64(len(body)), true},
		{"exactly the limit", int64(len(body)), -1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeServer{handlers: []func(*http.Request) *http.Response{func(r *http.Request) *http.Response {
				resp := reply(http.StatusOK, "application/json", body)(r)
				resp.ContentLength = tc.length
				return resp
			}}}
			c := newTestClient(t, f)
			c.MaxResponseBytes = tc.limit
			_, err := c.ListVaults(context.Background())
			if got := errors.Is(err, ErrResponseTooLarge); got != tc.tooLong {
				t.Fatalf("err: %v", err)
			}
		})
	}
}

// A download stops at the size announced for it, or at MaxDownloadBytes.
func TestDownloadsAreBounded(t *testing.T) {
	const content = "hello"
	serve := func(length int64) *fakeServer {
		return &fakeServer{handlers: []func(*http.Request) *http.Response{func(r *http.Request) *http.Response {
			resp := reply(http.StatusOK, "application/octet-stream", content)(r)
			resp.ContentLength = length
			return resp
		}}}
	}
	ctx := context.Background()
	for _, tc := range []struct {
		name     string
		ctx      context.Context
		max      int64
		length   int64
		tooLarge bool
	}{
		{"expected size", WithExpectedSize(ctx, 5), 0, -1, false},
		{"over the expected size", WithExpectedSize(ctx, 4), 0, -1, true},
		{"declared over the expected size", WithExpectedSize(ctx, 4), 0, 5, true},
		{"over the ceiling", ctx, 4, -1, true},
		{"expected size above the ceiling", WithExpectedSize(ctx, 5), 4, -1, false},
		{"no bound", ctx, 0, -1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, serve(tc.length))
			c.MaxDownloadBytes = tc.max
			var buf strings.Builder
			_, err := c.GetBlob(tc.ctx, testVaultID, testBlobHash, &buf)
			if got := errors.Is(err, ErrResponseTooLarge); got != tc.tooLarge {
				t.Fatalf("err: %v", err)
			}
			if !tc.tooLarge && buf.String() != content {
				t.Fatalf("content %q", buf.String())
			}
		})
	}
}

func TestCheckSecureURL(t *testing.T) {
	for raw, ok := range map[string]bool{
		"https://cloud.example.com":        true,
		"HTTPS://cloud.example.com/prefix": true,
		"http://localhost:18081":           true,
		"http://LocalHost":                 true,
		"http://127.0.0.1:8080":            true,
		"http://127.9.9.9":                 true,
		"http://[::1]:8080":                true,
		"http://[::ffff:127.0.0.1]":        true,
		"http://cloud.example.com":         false,
		"HTTP://cloud.example.com":         false,
		"http://localhost@evil.example":    false, // goes to evil.example
		"https://user:pw@cloud.example":    false,
		"http://user@localhost":            false,
		"http://127.0.0.1.nip.io":          false,
		"http://localhost.evil.example":    false,
		"http://0x7f000001":                false,
		"http://2130706433":                false,
		"http://0.0.0.0":                   false,
		"http://[::]":                      false,
		"http://[fe80::1%25lo0]":           false,
		"http://10.0.0.5":                  false,
		"ftp://localhost":                  false,
		"//localhost":                      false,
		"localhost:8080":                   false,
		"http://":                          false,
	} {
		err := CheckSecureURL(raw)
		if (err == nil) != ok {
			t.Errorf("%s: %v", raw, err)
		}
	}
	if err := CheckSecureURL("http://cloud.example.com"); !errors.Is(err, ErrInsecureURL) {
		t.Fatalf("err: %v", err)
	}
	if err := CheckSecureURL("https://alice:secret@cloud.example"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("the password must not be quoted: %v", err)
	}
}

// The identity of the cursor (ADR-0046): since_id goes with a positive
// cursor only, next_id and as_of_id are read back, and an answer without them
// (a server before ADR-0046) leaves them empty.
func TestCursorIdentityOnTheWire(t *testing.T) {
	const vid, id = "0190a0a0-0000-7000-8000-000000000001", "0190a0a0-0000-7000-8000-0000000000c1"
	page := reply(http.StatusOK, "application/json", `{"items":[],"next_seq":5,"next_id":"`+id+`","has_more":false}`)
	legacy := reply(http.StatusOK, "application/json", `{"items":[],"next_seq":5,"has_more":false}`)
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{page, page, page, legacy}}
	c := newTestClient(t, f)
	ctx := context.Background()
	for _, tc := range []struct {
		since   int64
		sinceID string
		query   string
		nextID  string
	}{
		{5, id, "since=5&since_id=" + id, id},
		{0, id, "since=0", id},           // nothing to verify at the start
		{5, "not-a-uuid", "since=5", id}, // an id this client cannot vouch for
		{5, id, "since=5&since_id=" + id, ""},
	} {
		ch, err := c.GetChanges(ctx, vid, tc.since, tc.sinceID, 0)
		if err != nil {
			t.Fatal(err)
		}
		if got := f.reqs[len(f.reqs)-1].query; got != tc.query || ch.NextID != tc.nextID {
			t.Fatalf("since %d %q: query %q, next_id %q", tc.since, tc.sinceID, got, ch.NextID)
		}
	}

	f = &fakeServer{handlers: []func(*http.Request) *http.Response{
		reply(http.StatusOK, "application/json", `{"as_of_seq":5,"as_of_id":"`+id+`","items":[]}`),
		reply(http.StatusOK, "application/json", `{"as_of_seq":5,"items":[]}`),
	}}
	c = newTestClient(t, f)
	if tr, err := c.GetTree(ctx, vid); err != nil || tr.AsOfSeq != 5 || tr.AsOfID != id {
		t.Fatalf("tree: %+v %v", tr, err)
	}
	if tr, err := c.GetTree(ctx, vid); err != nil || tr.AsOfID != "" {
		t.Fatalf("tree without as_of_id: %+v %v", tr, err)
	}
}

func TestDeviceRevokedProblem(t *testing.T) {
	baseRev := 1
	commit := syncproto.CommitRequest{DeviceID: "0190a0a0-0000-7000-8000-000000000004", Ops: []syncproto.Op{{OpID: "0190a0a0-0000-7000-8000-00000000000a", Op: syncproto.OpDelete, FileID: "0190a0a0-0000-7000-8000-00000000000b", BaseRev: &baseRev}}}
	vault := "0190a0a0-0000-7000-8000-000000000001"
	for _, tc := range []struct {
		name, body string
		revoked    bool
	}{
		{"reason", `{"type":"x","title":"Forbidden","status":403,"code":"FORBIDDEN","detail":"device revoked","extra":{"reason":"device_revoked"}}`, true},
		{"older server, detail only", `{"type":"x","title":"Forbidden","status":403,"code":"FORBIDDEN","detail":"device revoked"}`, true},
		{"another refusal", `{"type":"x","title":"Forbidden","status":403,"code":"FORBIDDEN","detail":"not an editor of the vault"}`, false},
		{"suspended user", `{"type":"x","title":"Forbidden","status":403,"code":"USER_SUSPENDED","detail":"device revoked"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeServer{handlers: []func(*http.Request) *http.Response{reply(http.StatusForbidden, "application/problem+json", tc.body)}}
			c := newTestClient(t, f)
			_, err := c.Commit(context.Background(), vault, commit)
			if err == nil {
				t.Fatal("commit accepted")
			}
			if got := IsDeviceRevoked(fmt.Errorf("push: %w", err)); got != tc.revoked {
				t.Fatalf("IsDeviceRevoked = %v, want %v (%v)", got, tc.revoked, err)
			}
			if !tc.revoked && errors.Is(err, ErrDeviceRevoked) {
				t.Fatal("errors.Is matched")
			}
		})
	}
}

func TestListDeletedVaultsAndPublicConfig(t *testing.T) {
	deleted := strings.Replace(vaultJSON, `"created_at"`, `"deleted_at":"2026-02-01T00:00:00Z","created_at"`, 1)
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{
		reply(http.StatusOK, "application/json", `{"items":[`+vaultJSON+`,`+deleted+`],"mounts":[]}`),
		reply(http.StatusOK, "application/json", `{"issuer":"https://id.example","desktop_client_id":"d","web_client_id":"w","audience":"a","grpc_endpoint":"g:1","api_version":"v"}`),
	}}
	c := newTestClient(t, f)
	vs, err := c.ListDeletedVaults(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(vs) != 1 || vs[0].DeletedAt == nil {
		t.Fatalf("deleted vaults: %+v", vs)
	}
	if f.reqs[0].query != "include_deleted=true" {
		t.Fatalf("query %q", f.reqs[0].query)
	}
	cc, err := c.GetClientConfig(context.Background())
	if err != nil || cc.DesktopClientId != "d" {
		t.Fatalf("client config: %+v %v", cc, err)
	}
	if f.reqs[1].header.Get("Authorization") != "" {
		t.Fatal("public operation sent a token")
	}
}

func TestInvalidIDsFailLocally(t *testing.T) {
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{reply(http.StatusOK, "application/json", vaultJSON)}}
	c := newTestClient(t, f)
	if _, err := c.RenameVault(context.Background(), "not-a-uuid", "x"); err == nil {
		t.Fatal("invalid id accepted")
	}
	if len(f.reqs) != 0 {
		t.Fatal("request sent")
	}
	if _, err := c.RenameVault(context.Background(), uuid.NewString(), "Renamed"); err != nil {
		t.Fatal(err)
	}
	if r := f.reqs[0]; r.method != http.MethodPatch || r.body != `{"name":"Renamed"}` || r.header.Get("Idempotency-Key") != "" {
		t.Fatalf("rename request %+v", r)
	}
}
