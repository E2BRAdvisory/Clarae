package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"clarae/shared/updatemanifest"
)

type fakeRunner struct {
	mu    sync.Mutex
	calls [][]string
}

func (f *fakeRunner) Start(name string, args ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, append([]string{name}, args...))
	return nil
}

type server struct {
	t        *testing.T
	priv     ed25519.PrivateKey
	manifest updatemanifest.Manifest
	payload  []byte
	rawOver  []byte // when set, served instead of the marshalled manifest
	sigOver  string
	srv      *httptest.Server
	hits     []string
	agents   []string
}

func newServer(t *testing.T) *server {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s := &server{t: t, priv: priv, payload: []byte(strings.Repeat("clarae-binary", 100))}
	s.srv = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.srv.Close)
	s.setManifest("1.1.0", 5)
	return s
}

func (s *server) setManifest(version string, seq int64) {
	sum := sha256.Sum256(s.payload)
	s.manifest = updatemanifest.Manifest{
		Schema: 1, Channel: "stable", Version: version, Sequence: seq, ReleasedAt: time.Now().UTC(), Notes: "# Notes",
		Artifacts: []updatemanifest.Artifact{
			{OS: "linux", Arch: "amd64", Kind: "deb", URL: s.srv.URL + "/a.deb", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(s.payload))},
			{OS: "linux", Arch: "amd64", Kind: "appimage", URL: s.srv.URL + "/a.AppImage", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(s.payload))},
		},
	}
}

func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	s.hits = append(s.hits, r.URL.Path)
	s.agents = append(s.agents, r.UserAgent())
	switch r.URL.Path {
	case "/stable/manifest.json", "/stable/manifest.json.sig":
		raw := s.rawOver
		if raw == nil {
			raw, _ = json.Marshal(s.manifest)
		}
		if strings.HasSuffix(r.URL.Path, ".sig") {
			sig := s.sigOver
			if sig == "" {
				sig, _ = updatemanifest.Sign(s.priv, raw)
			}
			_, _ = w.Write([]byte(sig))
			return
		}
		_, _ = w.Write(raw)
	case "/a.deb", "/a.AppImage":
		_, _ = w.Write(s.payload)
	default:
		http.NotFound(w, r)
	}
}

func (s *server) service(t *testing.T, current string, over ...func(*Options)) (*Service, *fakeRunner) {
	t.Helper()
	fr := &fakeRunner{}
	o := Options{
		DataDir: t.TempDir(), CurrentVersion: current, PublicKey: s.priv.Public().(ed25519.PublicKey),
		BaseURL: s.srv.URL, OS: "linux", Arch: "amd64", AllowInsecureLoopback: true,
		Applier: &SystemApplier{OS: "linux", Runner: fr},
	}
	for _, f := range over {
		f(&o)
	}
	svc, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	return svc, fr
}

func TestCheckDownloadEndToEnd(t *testing.T) {
	s := newServer(t)
	svc, fr := s.service(t, "1.0.0")
	st, err := svc.Check(context.Background())
	if err != nil || st.State != StateAvailable || st.Latest != "1.1.0" || st.Kind != "deb" {
		t.Fatalf("check: %+v %v", st, err)
	}
	for _, ua := range s.agents {
		if ua != "ClaraeUpdater" {
			t.Fatalf("user agent must not carry identifiers: %q", ua)
		}
	}
	res, err := svc.Install(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Method != MethodReveal || res.Quit {
		t.Fatalf("deb must only be revealed: %+v", res)
	}
	got, err := os.ReadFile(res.Path)
	if err != nil || string(got) != string(s.payload) {
		t.Fatalf("staged file: %v", err)
	}
	if len(fr.calls) != 1 || fr.calls[0][0] != "xdg-open" {
		t.Fatalf("reveal call: %v", fr.calls)
	}
	if svc.Status().State != StateReady {
		t.Fatalf("state %s", svc.Status().State)
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(res.Path), "*.part"))
	if len(left) != 0 {
		t.Fatalf("partial files left: %v", left)
	}
}

func TestUpToDateAndNoDowngrade(t *testing.T) {
	s := newServer(t)
	svc, _ := s.service(t, "1.1.0")
	if st, _ := svc.Check(context.Background()); st.State != StateUpToDate {
		t.Fatalf("same version: %+v", st)
	}
	s.setManifest("1.0.5", 6) // newer sequence but older version
	if st, _ := svc.Check(context.Background()); st.State != StateUpToDate {
		t.Fatalf("older version must never be offered: %+v", st)
	}
	svc2, _ := s.service(t, "1.2.0-rc.1")
	s.setManifest("1.2.0", 7)
	if st, _ := svc2.Check(context.Background()); st.State != StateAvailable {
		t.Fatalf("release must supersede its rc: %+v", st)
	}
}

func TestReplayAndRevocationFloor(t *testing.T) {
	s := newServer(t)
	svc, _ := s.service(t, "1.0.0")
	if _, err := svc.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.setManifest("1.1.0", 4) // an old, validly signed manifest replayed
	if _, err := svc.Check(context.Background()); !errors.Is(err, ErrReplay) {
		t.Fatalf("replay: %v", err)
	}
	// The ratchet survives a restart.
	svc2, err := New(svc.opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc2.Check(context.Background()); !errors.Is(err, ErrReplay) {
		t.Fatalf("replay after restart: %v", err)
	}
	s.setManifest("1.3.0", 9)
	s.manifest.MinVersion = "1.2.0"
	if st, err := svc2.Check(context.Background()); err != nil || !st.Required {
		t.Fatalf("floor above the running version must mark the update required: %+v %v", st, err)
	}
	s.setManifest("1.1.0", 10) // signed, newer sequence, but below the floor 1.2.0
	if _, err := svc2.Check(context.Background()); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked version: %v", err)
	}
}

func TestSignatureFailures(t *testing.T) {
	s := newServer(t)
	svc, _ := s.service(t, "1.0.0")
	raw, _ := json.Marshal(s.manifest)

	s.rawOver = []byte(strings.Replace(string(raw), "1.1.0", "9.9.9", 1)) // tampered after signing
	s.sigOver, _ = updatemanifest.Sign(s.priv, raw)
	if _, err := svc.Check(context.Background()); !errors.Is(err, updatemanifest.ErrBadSignature) {
		t.Fatalf("tampered: %v", err)
	}
	if svc.Status().State != StateError {
		t.Fatal("status must report the error")
	}

	_, other, _ := ed25519.GenerateKey(rand.Reader)
	s.rawOver = raw
	s.sigOver, _ = updatemanifest.Sign(other, raw) // wrong key
	if _, err := svc.Check(context.Background()); !errors.Is(err, updatemanifest.ErrBadSignature) {
		t.Fatalf("wrong key: %v", err)
	}

	// Unsigned garbage is rejected without being parsed (signature error, not a JSON error).
	s.rawOver = []byte("{not json")
	s.sigOver = "AAAA"
	if _, err := svc.Check(context.Background()); !errors.Is(err, updatemanifest.ErrBadSignature) {
		t.Fatalf("garbage: %v", err)
	}
}

func TestWrongChannelManifest(t *testing.T) {
	s := newServer(t)
	s.manifest.Channel = "beta" // a beta manifest served at the stable URL
	svc, _ := s.service(t, "1.0.0")
	if _, err := svc.Check(context.Background()); !errors.Is(err, ErrChannel) {
		t.Fatalf("channel: %v", err)
	}
}

func TestOversizeManifest(t *testing.T) {
	s := newServer(t)
	s.rawOver = []byte(strings.Repeat("x", maxManifestBytes+10))
	svc, _ := s.service(t, "1.0.0")
	if _, err := svc.Check(context.Background()); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize manifest: %v", err)
	}
}

func TestHashMismatchAndOversizeArtifact(t *testing.T) {
	s := newServer(t)
	svc, _ := s.service(t, "1.0.0")
	if _, err := svc.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.payload = []byte(strings.Repeat("evil-binary!!", 100)) // same size, other content
	if _, err := svc.Download(context.Background()); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("hash mismatch: %v", err)
	}
	if left, _ := filepath.Glob(filepath.Join(svc.opts.DataDir, "updates", "*")); len(left) != 0 {
		t.Fatalf("a rejected download must leave nothing staged: %v", left)
	}
	s.payload = append(s.payload, []byte("more")...) // larger than the signed size
	if _, err := svc.Download(context.Background()); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize artifact: %v", err)
	}
	s.payload = s.payload[:100] // shorter
	if _, err := svc.Download(context.Background()); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("truncated artifact: %v", err)
	}
}

func TestInsecureArtifactURLRejected(t *testing.T) {
	s := newServer(t)
	svc, _ := s.service(t, "1.0.0", func(o *Options) { o.AllowInsecureLoopback = false })
	if _, err := svc.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Download(context.Background()); !errors.Is(err, ErrInsecureURL) {
		t.Fatalf("http artifact: %v", err)
	}
}

func TestSettingsSkipAndDisabled(t *testing.T) {
	s := newServer(t)
	svc, _ := s.service(t, "1.0.0")
	if st := svc.Settings(); !st.Enabled || st.Channel != "stable" {
		t.Fatalf("defaults: %+v", st)
	}
	if err := svc.SetSettings(Settings{Enabled: true, Channel: "nightly"}); err == nil {
		t.Fatal("invalid channel accepted")
	}
	if _, err := svc.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := svc.Skip("1.1.0"); err != nil {
		t.Fatal(err)
	}
	if !svc.Status().Skipped {
		t.Fatal("skipped flag")
	}
	if err := svc.SetSettings(Settings{Enabled: false, Channel: "beta", SkippedVersion: "1.1.0"}); err != nil {
		t.Fatal(err)
	}
	again, _ := New(svc.opts)
	if got := again.Settings(); got.Enabled || got.Channel != "beta" || got.SkippedVersion != "1.1.0" {
		t.Fatalf("persistence: %+v", got)
	}

	dev, _ := s.service(t, "dev")
	if _, err := dev.Check(context.Background()); err == nil || dev.Status().Disabled == "" {
		t.Fatalf("a development build must not check: %v", err)
	}
	n := len(s.hits)
	managed, _ := s.service(t, "1.0.0", func(o *Options) { o.DisabledReason = "managed" })
	if _, err := managed.Check(context.Background()); err == nil {
		t.Fatal("managed check must fail")
	}
	managed.Run(context.Background()) // returns immediately
	if len(s.hits) != n {
		t.Fatal("disabled updater must not touch the network")
	}
}

func TestRunOptOutDoesNotFetch(t *testing.T) {
	s := newServer(t)
	svc, _ := s.service(t, "1.0.0", func(o *Options) { o.StartupDelay = time.Millisecond })
	if err := svc.SetSettings(Settings{Enabled: false, Channel: "stable"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	svc.Run(ctx)
	if len(s.hits) != 0 {
		t.Fatalf("opt-out must not fetch: %v", s.hits)
	}
}

func TestRunChecksOnStartup(t *testing.T) {
	s := newServer(t)
	got := make(chan Status, 8)
	svc, _ := s.service(t, "1.0.0", func(o *Options) {
		o.StartupDelay = time.Millisecond
		o.OnStatus = func(st Status) {
			if st.State == StateAvailable {
				select {
				case got <- st:
				default:
				}
			}
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go svc.Run(ctx)
	select {
	case st := <-got:
		if st.Latest != "1.1.0" {
			t.Fatalf("%+v", st)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no startup check")
	}
}

func TestDevKeyIsDefault(t *testing.T) {
	if !IsDevKey() {
		t.Fatal("tests run with the development key")
	}
	pub, err := publicKey()
	if err != nil || len(pub) != ed25519.PublicKeySize {
		t.Fatal(err)
	}
	if DevPublicKeyB64() == "" {
		t.Fatal("dev public key")
	}
}

// A manifest past its expires_at still works but the status carries a warning.
func TestExpiredManifestWarns(t *testing.T) {
	s := newServer(t)
	released := time.Now().UTC().Add(-48 * time.Hour)
	expires := released.Add(24 * time.Hour)
	s.manifest.ReleasedAt, s.manifest.ExpiresAt = released, &expires
	svc, _ := s.service(t, "1.0.0")
	st, err := svc.Check(context.Background())
	if err != nil || st.State != StateAvailable || !strings.Contains(st.Warning, "expired") {
		t.Fatalf("expired manifest: %+v %v", st, err)
	}
	fresh := time.Now().UTC().Add(24 * time.Hour)
	s.manifest.ExpiresAt = &fresh
	s.manifest.Sequence++
	if st, err := svc.Check(context.Background()); err != nil || st.Warning != "" {
		t.Fatalf("fresh manifest: %+v %v", st, err)
	}
}
