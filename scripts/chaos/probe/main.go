// Command probe is the availability probe of the chaos run (scripts/chaos/run-helm-chaos.sh).
// At a fixed rate it issues two requests against the cloud API: GET /readyz and
// an authenticated GET /me (a real call: JWT validation, user lookup in
// PostgreSQL). Every sample is written as one JSON line. Only the standard
// library is used, so it runs with "go run scripts/chaos/probe/main.go".
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

type sample struct {
	TS      int64   `json:"ts_ms"` // request start, Unix ms
	Kind    string  `json:"kind"`  // readyz | me
	Status  int     `json:"status"`
	Ms      float64 `json:"ms"`
	OK      bool    `json:"ok"`
	Err     string  `json:"err,omitempty"`
	Backend string  `json:"backend,omitempty"`
}

func main() {
	api := flag.String("api", "http://127.0.0.1:28081", "API base URL (without /api/v1)")
	tokenURL := flag.String("token-url", "", "OIDC token endpoint (password grant); empty = skip the authenticated probe")
	resolve := flag.String("resolve", "keycloak.localtest.me=127.0.0.1", "host=ip override for the token endpoint host")
	client := flag.String("client", "memobrain-desktop", "OIDC client id")
	user := flag.String("user", "user1", "user")
	pass := flag.String("password", "memobrain-dev-password", "password")
	rate := flag.Int("rate", 10, "probes per second (each tick sends one /readyz and one /me)")
	timeout := flag.Duration("timeout", 2*time.Second, "per-request timeout; slower counts as failed")
	out := flag.String("out", "samples.jsonl", "output file")
	flag.Parse()

	f, err := os.Create(*out)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer func() { _ = f.Close() }()
	var wmu sync.Mutex
	enc := json.NewEncoder(f)
	write := func(s sample) { wmu.Lock(); _ = enc.Encode(s); wmu.Unlock() }

	// A fresh connection per request: a probe that reuses a keep-alive connection to
	// one pod would not see what a new client sees through the load balancer.
	hc := &http.Client{Timeout: *timeout, Transport: &http.Transport{DisableKeepAlives: true}}

	var tokMu sync.RWMutex
	token := ""
	if *tokenURL != "" {
		fetch := func() error {
			t, err := passwordToken(*tokenURL, *resolve, *client, *user, *pass)
			if err != nil {
				return err
			}
			tokMu.Lock()
			token = t
			tokMu.Unlock()
			return nil
		}
		if err := fetch(); err != nil {
			fmt.Fprintln(os.Stderr, "cannot get a token:", err)
			os.Exit(1)
		}
		go func() {
			for range time.Tick(2 * time.Minute) { // tokens live 5 min
				if err := fetch(); err != nil {
					fmt.Fprintln(os.Stderr, "token refresh:", err)
				}
			}
		}()
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var wg sync.WaitGroup
	probe := func(kind, path string) {
		defer wg.Done()
		s := sample{TS: time.Now().UnixMilli(), Kind: kind}
		req, _ := http.NewRequest(http.MethodGet, *api+"/api/v1"+path, nil)
		if kind == "me" {
			tokMu.RLock()
			req.Header.Set("Authorization", "Bearer "+token)
			tokMu.RUnlock()
		}
		start := time.Now()
		resp, err := hc.Do(req)
		s.Ms = float64(time.Since(start).Microseconds()) / 1000
		if err != nil {
			s.Err = shorten(err.Error())
		} else {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			s.Status = resp.StatusCode
			s.OK = resp.StatusCode == http.StatusOK
		}
		write(s)
	}
	tick := time.NewTicker(time.Second / time.Duration(*rate))
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case <-tick.C:
			wg.Add(1)
			go probe("readyz", "/readyz")
			if *tokenURL != "" {
				wg.Add(1)
				go probe("me", "/me")
			}
		}
	}
}

func shorten(s string) string {
	if i := strings.LastIndex(s, ": "); i >= 0 && len(s) > 80 {
		return s[i+2:]
	}
	return s
}

func passwordToken(tokenURL, resolve, client, user, pass string) (string, error) {
	u, err := url.Parse(tokenURL)
	if err != nil {
		return "", err
	}
	host, ip, _ := strings.Cut(resolve, "=")
	d := &net.Dialer{Timeout: 5 * time.Second}
	hc := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			h, p, _ := net.SplitHostPort(addr)
			if h == host && ip != "" {
				addr = net.JoinHostPort(ip, p)
			}
			return d.DialContext(ctx, network, addr)
		},
	}}
	resp, err := hc.PostForm(u.String(), url.Values{"grant_type": {"password"}, "client_id": {client}, "username": {user}, "password": {pass}, "scope": {"openid"}})
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	var tr struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(b, &tr); err != nil || tr.AccessToken == "" {
		return "", fmt.Errorf("token endpoint answered %d: %s", resp.StatusCode, b)
	}
	return tr.AccessToken, nil
}
