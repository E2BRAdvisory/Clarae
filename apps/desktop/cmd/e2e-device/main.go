//go:build e2e

// Command e2e-device is a headless desktop device for the mixed-client e2e suite (P7 of the W8
// review, web/e2e-mixed): the real desktop core (internal/app, the same bindings Wails exposes,
// the real sync engine, the on-disk vault folders) without a window. The Playwright specs drive
// it over a small HTTP API on the loopback interface while a browser runs the web workbench
// against the same cloud.
//
// Instead of the system-browser sign-in it signs in with the resource-owner password grant of
// the throwaway Keycloak realm (scripts/e2e-mixed.sh enables it on clarae-desktop there, never
// in the shipped realm) and hands the tokens to the core as a hosted session (auth.Hosted, the
// path the browser build uses). Vault keys stay in memory.
//
//	go build -tags e2e -o .dev/bin/e2e-device ./cmd/e2e-device
//	e2e-device -server http://localhost:18091 -issuer http://localhost:8080/realms/clarae \
//	    -user user1 -password clarae-dev-password -data /tmp/devA
//
// It prints "LISTEN http://127.0.0.1:<port>" on stdout once ready. API (JSON):
//
//	POST /call   {"service":"SyncAPI","method":"SyncNow","args":["<vault id>"]} -> result | {"error"}
//	GET  /events  every event the core emitted, in order: [{"seq","name","payload"}]
//	GET  /file?vault=<local id>&path=<rel>   the file's bytes on disk (404 when missing)
//	PUT  /file?vault=<local id>&path=<rel>   writes the file on disk, as an editor outside the app would
//	GET  /files?vault=<local id>             every file of the vault folder (paths, without .clarae)
//	POST /quit
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/app"
	"clarae/apps/desktop/internal/auth"
	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/rpc"
)

func main() {
	server := flag.String("server", "http://localhost:18091", "cloud base URL")
	issuer := flag.String("issuer", "http://localhost:8080/realms/clarae", "OIDC issuer (Keycloak realm)")
	clientID := flag.String("client", "clarae-desktop", "OIDC client with the password grant enabled")
	user := flag.String("user", "user1", "user name")
	password := flag.String("password", "clarae-dev-password", "password")
	dataDir := flag.String("data", "", "data directory (required)")
	listen := flag.String("listen", "127.0.0.1:0", "address of the control API")
	verbose := flag.Bool("v", false, "log the core to stderr")
	flag.Parse()
	if *dataDir == "" {
		log.Fatal("-data is required")
	}
	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatal(err)
	}

	logger := zerolog.Nop()
	if *verbose {
		logger = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr}).With().Timestamp().Str("device", *user).Logger()
	}
	tokens := &passwordGrant{issuer: *issuer, clientID: *clientID, user: *user, password: *password, hc: &http.Client{Timeout: 30 * time.Second}}
	if _, err := tokens.Token(context.Background()); err != nil {
		log.Fatalf("sign in as %s: %v", *user, err)
	}
	h := &host{server: *server, tokens: tokens}
	a := app.New(app.Options{DataDir: *dataDir, Logger: logger, Version: "e2e", KeyStore: crypto.NewMemoryStore(), Host: h})
	d := rpc.New()
	for _, s := range a.Services() {
		if err := d.Register(s); err != nil {
			log.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.Startup(ctx)
	a.DomReady(ctx)

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	quit := make(chan struct{})
	srv := &http.Server{Handler: h.routes(d, quit), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	fmt.Printf("LISTEN http://%s\n", ln.Addr())

	<-quit
	a.Shutdown(ctx)
	cancel()
	shutdown, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	_ = srv.Shutdown(shutdown)
}

// passwordGrant signs in with the resource-owner password grant and renews the token before it expires.
type passwordGrant struct {
	issuer, clientID, user, password string
	hc                               *http.Client

	mu      sync.Mutex
	access  string
	expires time.Time
}

func (p *passwordGrant) Token(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.access != "" && time.Until(p.expires) > 30*time.Second {
		return p.access, nil
	}
	form := url.Values{
		"grant_type": {"password"}, "client_id": {p.clientID}, "username": {p.user}, "password": {p.password}, "scope": {"openid"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.issuer, "/")+"/protocol/openid-connect/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := p.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint: %s: %s", res.Status, body)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", fmt.Errorf("token endpoint: %w", err)
	}
	if tok.AccessToken == "" {
		return "", errors.New("token endpoint: no access token")
	}
	p.access, p.expires = tok.AccessToken, time.Now().Add(time.Duration(tok.ExpiresIn)*time.Second)
	return p.access, nil
}

type event struct {
	Seq     int             `json:"seq"`
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
}

// host is a window-less app.Host that owns the sign-in (app.SessionHost).
type host struct {
	server string
	tokens *passwordGrant

	mu     sync.Mutex
	events []event
}

func (h *host) Session() *auth.Hosted {
	return &auth.Hosted{ServerURL: h.server, Token: h.tokens.Token}
}

func (h *host) Emit(_ context.Context, name string, payload any) {
	b, err := json.Marshal(payload)
	if err != nil {
		b = []byte("null")
	}
	h.mu.Lock()
	h.events = append(h.events, event{Seq: len(h.events) + 1, Name: name, Payload: b})
	h.mu.Unlock()
}

func (h *host) SaveFile(context.Context, app.SaveDialog) (string, error) {
	return "", errors.New("no dialogs in the e2e device")
}
func (h *host) Delivered(context.Context, string) {}
func (h *host) OpenFile(context.Context, app.OpenDialog) (string, error) {
	return "", errors.New("no dialogs in the e2e device")
}
func (h *host) OpenDirectory(context.Context, app.OpenDialog) (string, error) {
	return "", errors.New("no dialogs in the e2e device")
}
func (h *host) OpenPath(context.Context, string) error {
	return errors.New("no system applications in the e2e device")
}
func (h *host) RevealPath(context.Context, string) error {
	return errors.New("no file manager in the e2e device")
}
func (h *host) OpenURL(context.Context, string)                  {}
func (h *host) Print(context.Context)                            {}
func (h *host) ShowWindow(context.Context)                       {}
func (h *host) Quit(context.Context)                             {}
func (h *host) ErrorDialog(_ context.Context, title, msg string) { log.Printf("%s: %s", title, msg) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *host) routes(d *rpc.Dispatcher, quit chan struct{}) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /call", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Service string            `json:"service"`
			Method  string            `json:"method"`
			Args    []json.RawMessage `json:"args"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		args := "[]"
		if len(req.Args) > 0 {
			b, _ := json.Marshal(req.Args)
			args = string(b)
		}
		res, err := d.Call(req.Service, req.Method, args)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"result":`+res+`}`)
	})
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, _ *http.Request) {
		h.mu.Lock()
		out := append([]event{}, h.events...)
		h.mu.Unlock()
		writeJSON(w, http.StatusOK, out)
	})
	// root resolves the folder of an open vault from its local id.
	root := func(r *http.Request) (string, error) {
		res, err := d.Call("VaultAPI", "ListOpen", "[]")
		if err != nil {
			return "", err
		}
		var open []app.VaultInfo
		if err := json.Unmarshal([]byte(res), &open); err != nil {
			return "", err
		}
		id := r.URL.Query().Get("vault")
		for _, v := range open {
			if v.ID == id {
				return v.Path, nil
			}
		}
		return "", fmt.Errorf("vault %q is not open", id)
	}
	inside := func(dir, rel string) (string, error) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if rel == "" || !strings.HasPrefix(p, filepath.Clean(dir)+string(filepath.Separator)) {
			return "", errors.New("invalid path")
		}
		return p, nil
	}
	mux.HandleFunc("GET /file", func(w http.ResponseWriter, r *http.Request) {
		dir, err := root(r)
		if err == nil {
			var p string
			if p, err = inside(dir, r.URL.Query().Get("path")); err == nil {
				var b []byte
				if b, err = os.ReadFile(p); err == nil {
					_, _ = w.Write(b)
					return
				}
			}
		}
		http.Error(w, err.Error(), http.StatusNotFound)
	})
	mux.HandleFunc("PUT /file", func(w http.ResponseWriter, r *http.Request) {
		dir, err := root(r)
		if err == nil {
			var p string
			if p, err = inside(dir, r.URL.Query().Get("path")); err == nil {
				b, _ := io.ReadAll(r.Body)
				if err = os.MkdirAll(filepath.Dir(p), 0o755); err == nil {
					err = os.WriteFile(p, b, 0o644)
				}
			}
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /files", func(w http.ResponseWriter, r *http.Request) {
		dir, err := root(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		out := []string{}
		_ = filepath.WalkDir(dir, func(p string, de fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if de.IsDir() {
				if p != dir && (de.Name() == ".clarae" || de.Name() == ".trash") {
					return filepath.SkipDir
				}
				return nil
			}
			rel, _ := filepath.Rel(dir, p)
			out = append(out, filepath.ToSlash(rel))
			return nil
		})
		sort.Strings(out)
		writeJSON(w, http.StatusOK, out)
	})
	var once sync.Once
	mux.HandleFunc("POST /quit", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		once.Do(func() { close(quit) })
	})
	return mux
}
