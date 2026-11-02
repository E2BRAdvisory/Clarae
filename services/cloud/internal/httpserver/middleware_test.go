package httpserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestClientIP(t *testing.T) {
	proxies := NewClientIP([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("fd00::/8")})
	for _, c := range []struct {
		name   string
		ip     ClientIP
		remote string
		xff    []string
		want   string
	}{
		{"no proxies: peer without port", NewClientIP(nil), "203.0.113.7:51234", nil, "203.0.113.7"},
		{"no proxies: header ignored", NewClientIP(nil), "203.0.113.7:51234", []string{"198.51.100.1"}, "203.0.113.7"},
		{"untrusted peer: header ignored", proxies, "203.0.113.7:1", []string{"198.51.100.1"}, "203.0.113.7"},
		{"one trusted hop", proxies, "10.1.2.3:443", []string{"198.51.100.1"}, "198.51.100.1"},
		{"spoofed entry left of the client", proxies, "10.1.2.3:443", []string{"1.1.1.1, 198.51.100.1"}, "198.51.100.1"},
		{"chain of trusted hops", proxies, "10.1.2.3:443", []string{"198.51.100.1, 10.9.9.9", "10.8.8.8"}, "198.51.100.1"},
		{"all hops trusted", proxies, "10.1.2.3:443", []string{"10.5.5.5"}, "10.5.5.5"},
		{"malformed hop stops the walk", proxies, "10.1.2.3:443", []string{"198.51.100.1, garbage"}, "10.1.2.3"},
		{"no header from a trusted peer", proxies, "10.1.2.3:443", nil, "10.1.2.3"},
		{"ipv6 peer", proxies, "[fd00::1]:443", []string{"2001:db8::5"}, "2001:db8::5"},
		{"ipv4-mapped peer", proxies, "[::ffff:10.1.2.3]:443", []string{"198.51.100.1"}, "198.51.100.1"},
		{"unparsable peer kept as is", proxies, "pipe", nil, "pipe"},
	} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = c.remote
		for _, v := range c.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := c.ip.Of(r); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// Regression (D2): the key included the port, so every new connection got a
// fresh bucket and the per-IP limit never triggered.
func TestByIPSharesTheBucketAcrossConnections(t *testing.T) {
	rl := NewRateLimiter(0.001, 2)
	h := rl.ByIP(NewClientIP(nil))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	codes := []int{}
	for port := range 3 {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
		r.RemoteAddr = "203.0.113.7:" + strconv.Itoa(51000+port)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		codes = append(codes, rec.Code)
	}
	if codes[2] != http.StatusTooManyRequests {
		t.Fatalf("codes %v: the third request from the same address was not limited", codes)
	}
}

func TestByIPExemptsHealthProbes(t *testing.T) {
	rl := NewRateLimiter(0.001, 1)
	h := rl.ByIP(NewClientIP(nil))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for range 5 {
		for _, p := range []string{"/api/v1/healthz", "/api/v1/readyz"} {
			for _, peer := range []string{"10.0.3.4:40000", "127.0.0.1:40000", "[fd00::4]:40000", "100.64.1.2:40000"} {
				r := httptest.NewRequest(http.MethodGet, p, nil)
				r.RemoteAddr = peer
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, r)
				if rec.Code != http.StatusNoContent {
					t.Fatalf("%s from %s throttled: %d", p, peer, rec.Code)
				}
			}
		}
	}
}

// Probes relayed by a proxy, or coming straight from the internet, are limited like any request:
// otherwise anyone could hammer /readyz without a budget.
func TestByIPLimitsPublicAndProxiedProbes(t *testing.T) {
	for name, set := range map[string]func(*http.Request){
		"public peer":  func(r *http.Request) { r.RemoteAddr = "203.0.113.7:4000" },
		"via ingress":  func(r *http.Request) { r.RemoteAddr = "10.0.0.2:4000"; r.Header.Set("X-Forwarded-For", "203.0.113.7") },
		"via RFC 7239": func(r *http.Request) { r.RemoteAddr = "10.0.0.2:4000"; r.Header.Set("Forwarded", "for=203.0.113.7") },
	} {
		rl := NewRateLimiter(0.001, 1)
		h := rl.ByIP(NewClientIP(nil))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		codes := []int{}
		for range 3 {
			r := httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil)
			set(r)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			codes = append(codes, rec.Code)
		}
		if codes[2] != http.StatusTooManyRequests {
			t.Errorf("%s: codes %v, the probe was not limited", name, codes)
		}
	}
}

// Regression (M12): the request log recorded the proxy's address, so behind
// Caddy or an ingress every line had the same ip and could not be matched
// with audit_log.ip.
func TestRequestLoggerRecordsTheResolvedClient(t *testing.T) {
	var buf bytes.Buffer
	ip := NewClientIP([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	h := RequestLogger(zerolog.New(&buf), ip)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	r := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	r.RemoteAddr = "10.0.0.2:4000"
	r.Header.Set("X-Forwarded-For", "203.0.113.7")
	h.ServeHTTP(httptest.NewRecorder(), r)
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("%v: %s", err, buf.String())
	}
	if line["ip"] != "203.0.113.7" || line["peer"] != "10.0.0.2:4000" {
		t.Fatalf("ip %v peer %v, want the client and the proxy", line["ip"], line["peer"])
	}
}

func TestRateLimiterTake(t *testing.T) {
	rl := NewRateLimiter(1, 2)
	for i := range 2 {
		if ok, _ := rl.Take("k"); !ok {
			t.Fatalf("take %d refused within the burst", i)
		}
	}
	ok, wait := rl.Take("k")
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("over the burst: ok=%v wait=%s", ok, wait)
	}
	if ok, _ := rl.Take("other"); !ok {
		t.Fatal("keys share a bucket")
	}
}
