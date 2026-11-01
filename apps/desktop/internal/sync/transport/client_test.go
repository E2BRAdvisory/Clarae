package transport

import (
	"context"
	"errors"
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
	_, err := c.GetChanges(context.Background(), "0190a0a0-0000-7000-8000-000000000001", 5, 0)
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
	if !errors.As(err, &pe) || pe.StatusCode != http.StatusBadGateway || pe.Problem.Code != syncproto.CodeInternal || !strings.Contains(pe.Problem.Detail, "bad gateway") {
		t.Fatalf("err: %#v", err)
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
