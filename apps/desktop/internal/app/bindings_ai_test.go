//go:build !js

package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"clarae/apps/desktop/internal/ai"
	"clarae/apps/desktop/internal/store"
	syncpkg "clarae/apps/desktop/internal/sync"
)

// aiRecorder counts the HTTP requests the assistant makes.
type aiRecorder struct{ n atomic.Int64 }

func (r *aiRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	r.n.Add(1)
	return http.DefaultTransport.RoundTrip(req)
}

// aiHarness is an app whose assistant talks to a local server through a recording client.
type aiHarness struct {
	a       *App
	vaultID string
	root    string
	rec     *aiRecorder
	hits    *atomic.Int64
	secrets *ai.MemorySecrets

	mu     sync.Mutex
	events []string // "name payloadjson"
	done   chan AIDonePayload
}

// newAIHarness builds the app with the build constant ON, the profile flag OFF and no provider
// configured: each test opens the gates it needs.
func newAIHarness(t *testing.T) *aiHarness {
	t.Helper()
	a, info, root := newTestApp(t)
	h := &aiHarness{a: a, vaultID: info.ID, root: root, rec: &aiRecorder{}, hits: new(atomic.Int64), secrets: &ai.MemorySecrets{}, done: make(chan AIDonePayload, 4)}
	a.setEmitter(func(name string, payload any) {
		raw, _ := json.Marshal(payload)
		h.mu.Lock()
		h.events = append(h.events, name+" "+string(raw))
		h.mu.Unlock()
		if d, ok := payload.(AIDonePayload); ok {
			h.done <- d
		}
	})
	a.ai.tune = func(o *ai.Options) {
		o.Build = func() bool { return true }
		o.Secrets = h.secrets
		o.Client = &http.Client{Transport: h.rec}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.hits.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Ciao \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"mondo\"}}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(a.shutdownAI)
	h.writeConfig(t, srv.URL)
	return h
}

func (h *aiHarness) writeConfig(t *testing.T, baseURL string) {
	t.Helper()
	cfg := fmt.Sprintf(`{"provider":"openai","model":"m","baseUrl":%q}`, baseURL)
	if err := os.WriteFile(filepath.Join(h.a.opts.DataDir, ai.ConfigFile), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (h *aiHarness) flagOn(t *testing.T) {
	refreshWith(t, h.a, map[string]any{"features": map[string]any{"ai": true}})
}

// linkAs records in the sync database of the vault that it is linked to a cloud vault of this kind,
// as Link would, without a server.
func (h *aiHarness) linkAs(t *testing.T, kind string) {
	t.Helper()
	ctx := context.Background()
	sdb, err := store.Open(ctx, filepath.Join(h.root, ".clarae", "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	db := syncpkg.NewDB(sdb)
	meta := map[string]string{syncpkg.MetaCloudVault: "00000000-0000-7000-8000-000000000001", syncpkg.MetaKind: kind}
	if kind == "" { // a link interrupted between the keys of saveLink: the cloud vault, no kind
		delete(meta, syncpkg.MetaKind)
	}
	for k, v := range meta {
		if err := db.SetMeta(ctx, k, v); err != nil {
			t.Fatal(err)
		}
	}
}

// breakSyncMeta drops the meta table of the sync database, from another connection: the link of the vault can no
// longer be read (Info used to take that for a vault that is not linked, which is open to the assistant).
func (h *aiHarness) breakSyncMeta(t *testing.T) {
	t.Helper()
	sdb, err := store.Open(context.Background(), filepath.Join(h.root, ".clarae", "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	if _, err := sdb.ExecContext(context.Background(), `DROP TABLE sync_meta`); err != nil {
		t.Fatal(err)
	}
}

func (h *aiHarness) request() AIStartRequest {
	return AIStartRequest{VaultID: h.vaultID, RequestID: "req-1", Document: "# Note\n\nhello\n", Selection: "hello", Instruction: "translate"}
}

func (h *aiHarness) api() *AIAPI { return NewAIAPI(h.a) }

// names lists the events of the assistant that were sent (others, such as the indexing progress of the vault, are not its).
func (h *aiHarness) names() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, e := range h.events {
		if name := strings.SplitN(e, " ", 2)[0]; strings.HasPrefix(name, "ai:") {
			out = append(out, name)
		}
	}
	return out
}

func codeOf(err error) string {
	var ce *codedError
	if errors.As(err, &ce) {
		return ce.code
	}
	return ""
}

// Whatever gate is closed, the binding refuses with its code, sends no event and makes no request.
func TestAIAPIRefusesBeforeAnyRequest(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(*testing.T, *aiHarness)
		code   string
		reason string
	}{
		{"profile flag off (the default)", func(t *testing.T, h *aiHarness) {
			_ = h.secrets.Set("sk-key")
			h.linkAs(t, "shared")
		}, ErrCodeAIDisabled, "profile"},
		{"profile sets the flag off", func(t *testing.T, h *aiHarness) {
			_ = h.secrets.Set("sk-key")
			refreshWith(t, h.a, map[string]any{"features": map[string]any{"ai": false}})
		}, ErrCodeAIDisabled, "profile"},
		{"private vault", func(t *testing.T, h *aiHarness) {
			_ = h.secrets.Set("sk-key")
			h.flagOn(t)
			h.linkAs(t, "private")
		}, ErrCodeAIPrivateVault, "private-vault"},
		{"linked vault without a kind (fail closed)", func(t *testing.T, h *aiHarness) {
			_ = h.secrets.Set("sk-key")
			h.flagOn(t)
			h.linkAs(t, "")
		}, ErrCodeAIPrivateVault, "private-vault"},
		{"meta table of the link unreadable (fail closed)", func(t *testing.T, h *aiHarness) {
			_ = h.secrets.Set("sk-key")
			h.flagOn(t)
			h.linkAs(t, "shared")
			h.breakSyncMeta(t)
		}, ErrCodeAIPrivateVault, "private-vault"},
		{"vault the core does not know", func(t *testing.T, h *aiHarness) {
			_ = h.secrets.Set("sk-key")
			h.flagOn(t)
			h.vaultID = "no-such-vault"
		}, ErrCodeAIPrivateVault, "private-vault"},
		{"no provider file", func(t *testing.T, h *aiHarness) {
			_ = h.secrets.Set("sk-key")
			h.flagOn(t)
			_ = os.Remove(filepath.Join(h.a.opts.DataDir, ai.ConfigFile))
		}, ErrCodeAINotConfigured, "not-configured"},
		{"no key for the provider", func(t *testing.T, h *aiHarness) {
			h.flagOn(t)
			h.writeConfig(t, "https://api.example.com")
		}, ErrCodeAINotConfigured, "not-configured"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newAIHarness(t)
			c.setup(t, h)
			st, err := h.api().Status(h.vaultID)
			if err != nil || st.Available || st.Reason != c.reason {
				t.Fatalf("Status = %+v, %v", st, err)
			}
			err = h.api().Start(h.request())
			if codeOf(err) != c.code {
				t.Fatalf("Start = %v, want code %s", err, c.code)
			}
			if h.rec.n.Load() != 0 || h.hits.Load() != 0 || len(h.names()) != 0 {
				t.Fatalf("%d requests, %d hits, events %v: a refusal must be silent", h.rec.n.Load(), h.hits.Load(), h.names())
			}
		})
	}
}

// A released build has the constant off: a profile with ai=true, a key and a provider change nothing.
func TestAIAPIIsOffInTheDefaultBuild(t *testing.T) {
	h := newAIHarness(t)
	h.a.ai.tune = func(o *ai.Options) { // the build constant as the source has it, the rest as in a managed install
		o.Secrets = h.secrets
		o.Client = &http.Client{Transport: h.rec}
	}
	_ = h.secrets.Set("sk-key")
	h.flagOn(t)
	st, _ := h.api().Status(h.vaultID)
	if st.Available || st.Build || st.Reason != "build" {
		t.Fatalf("Status = %+v", st)
	}
	if err := h.api().Start(h.request()); codeOf(err) != ErrCodeAIDisabled {
		t.Fatalf("Start = %v", err)
	}
	if err := h.api().SetKey("sk-other"); codeOf(err) != ErrCodeAIDisabled {
		t.Fatalf("SetKey = %v", err)
	}
	if k, _ := h.secrets.Get(); k != "sk-key" {
		t.Fatalf("the key changed: %q", k)
	}
	if h.rec.n.Load() != 0 || h.hits.Load() != 0 {
		t.Fatalf("%d requests with the function off", h.rec.n.Load())
	}
}

// With every gate open the answer arrives as chunk events in order, then one done.
func TestAIAPIStreamsTheAnswerAsEvents(t *testing.T) {
	h := newAIHarness(t)
	_ = h.secrets.Set("sk-key")
	h.flagOn(t)
	h.linkAs(t, "shared") // a shared cloud vault is not E2EE

	st, err := h.api().Status(h.vaultID)
	if err != nil || !st.Available || st.Provider != "openai" || st.Model != "m" || !st.Build || !st.Flag || st.Private || !st.Configured {
		t.Fatalf("Status = %+v, %v", st, err)
	}
	if raw, _ := json.Marshal(st); strings.Contains(string(raw), "sk-key") {
		t.Fatalf("Status carries the key: %s", raw)
	}
	if err := h.api().Start(h.request()); err != nil {
		t.Fatal(err)
	}
	select {
	case d := <-h.done:
		if !d.OK || d.RequestID != "req-1" || d.Cancelled || d.Error != "" {
			t.Fatalf("done = %+v", d)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no ai:done")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	want := []string{`ai:chunk {"requestId":"req-1","seq":0,"text":"Ciao "}`, `ai:chunk {"requestId":"req-1","seq":1,"text":"mondo"}`,
		`ai:done {"requestId":"req-1","ok":true,"cancelled":false,"error":""}`}
	var got []string
	for _, e := range h.events {
		if strings.HasPrefix(e, "ai:") {
			got = append(got, e)
		}
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("events:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if h.hits.Load() != 1 {
		t.Fatalf("%d requests, want 1", h.hits.Load())
	}
}

func TestAIAPICancel(t *testing.T) {
	h := newAIHarness(t)
	_ = h.secrets.Set("sk-key")
	h.flagOn(t)
	hold := make(chan struct{})
	defer close(hold)
	h.a.ai.tune = func(o *ai.Options) {
		o.Build = func() bool { return true }
		o.Secrets = h.secrets
		o.Provider = func(ai.Config, string) ai.Provider { return &ai.Fake{Chunks: []string{"a", "b"}, Hold: hold} }
	}
	if err := h.api().Start(h.request()); err != nil {
		t.Fatal(err)
	}
	if !h.api().Cancel("req-1") {
		t.Fatal("Cancel found no request")
	}
	if d := <-h.done; !d.Cancelled || d.OK {
		t.Fatalf("done = %+v", d)
	}
	if h.api().Cancel("req-1") || h.api().Cancel("never-started") {
		t.Fatal("nothing is left to cancel")
	}
}

func TestAIAPISetKeyIsWriteOnly(t *testing.T) {
	h := newAIHarness(t)
	if err := h.api().SetKey("sk-stored"); err != nil {
		t.Fatal(err)
	}
	if k, _ := h.secrets.Get(); k != "sk-stored" {
		t.Fatalf("stored %q", k)
	}
	if err := h.api().SetKey("bad key"); codeOf(err) != ErrCodeAIInvalid {
		t.Fatalf("SetKey(bad key) = %v", err)
	}
}

// No method of AIAPI hands anything back that could be the key: Status is a record of booleans and
// names, Start and SetKey return an error, Cancel a boolean.
func TestAIAPIReturnsNoSecret(t *testing.T) {
	typ := reflect.TypeFor[*AIAPI]()
	for i := range typ.NumMethod() {
		m := typ.Method(i)
		for j := range m.Type.NumOut() {
			out := m.Type.Out(j)
			if out.Kind() == reflect.String || (out.Kind() == reflect.Struct && out != reflect.TypeFor[AIStatus]()) {
				t.Errorf("AIAPI.%s returns %s", m.Name, out)
			}
		}
	}
	for i := range reflect.TypeFor[AIStatus]().NumField() {
		f := reflect.TypeFor[AIStatus]().Field(i)
		if strings.Contains(strings.ToLower(f.Name), "key") || strings.Contains(strings.ToLower(f.Name), "secret") {
			t.Errorf("AIStatus.%s could carry a secret", f.Name)
		}
	}
}

// The flag is read from the profile in force at each call, not when the service is built.
func TestAIAPIFollowsTheProfile(t *testing.T) {
	h := newAIHarness(t)
	_ = h.secrets.Set("sk-key")
	if st, _ := h.api().Status(h.vaultID); st.Flag || st.Available {
		t.Fatalf("Status before the profile = %+v", st)
	}
	h.flagOn(t)
	if st, _ := h.api().Status(h.vaultID); !st.Available {
		t.Fatalf("Status with the flag on = %+v", st)
	}
	refreshWith(t, h.a, map[string]any{"features": map[string]any{"ai": false}})
	if st, _ := h.api().Status(h.vaultID); st.Available || st.Reason != "profile" {
		t.Fatalf("Status with the flag off again = %+v", st)
	}
}
