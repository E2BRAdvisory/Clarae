package httpserver

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/hlog"
	"golang.org/x/time/rate"

	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

// RequestLogger logs one line per request with the request id, status,
// duration and (when authenticated) the user id set by the auth middleware.
// ip is the client address resolved through the trusted proxies (the one
// audit_log records), peer the TCP peer, which behind a proxy is the proxy.
func RequestLogger(logger zerolog.Logger, ip ClientIP) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			l := logger.With().Str("request_id", middleware.GetReqID(r.Context())).Logger()
			r = r.WithContext(l.WithContext(r.Context()))
			next.ServeHTTP(ww, r)
			evt := hlog.FromRequest(r).Info()
			if ww.Status() >= http.StatusInternalServerError {
				evt = hlog.FromRequest(r).Error()
			}
			evt.Str("method", r.Method).
				Str("path", r.URL.Path).
				Int("status", ww.Status()).
				Int("bytes", ww.BytesWritten()).
				Dur("duration", time.Since(start)).
				Str("ip", ip.Of(r)).
				Str("peer", r.RemoteAddr).
				Msg("request")
		})
	}
}

// Recoverer turns panics into a 500 problem document and logs the stack.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec)
				}
				zerolog.Ctx(r.Context()).Error().
					Interface("panic", rec).
					Bytes("stack", debug.Stack()).
					Msg("panic recovered")
				httpproblem.Write(w, r, syncproto.CodeInternal, "", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// RateLimiter is a token-bucket limiter keyed by an arbitrary string (client
// IP before authentication, user id after). Idle keys are evicted.
type RateLimiter struct {
	rate  rate.Limit
	burst int
	mu    sync.Mutex
	items map[string]*limiterEntry
}

type limiterEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

// NewRateLimiter allows perSecond sustained requests with the given burst.
func NewRateLimiter(perSecond float64, burst int) *RateLimiter {
	rl := &RateLimiter{rate: rate.Limit(perSecond), burst: burst, items: map[string]*limiterEntry{}}
	go rl.evictLoop()
	return rl
}

func (rl *RateLimiter) get(key string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	e, ok := rl.items[key]
	if !ok {
		e = &limiterEntry{lim: rate.NewLimiter(rl.rate, rl.burst)}
		rl.items[key] = e
	}
	e.seen = time.Now()
	return e.lim
}

func (rl *RateLimiter) evictLoop() {
	for range time.Tick(time.Minute) {
		cutoff := time.Now().Add(-5 * time.Minute)
		rl.mu.Lock()
		for k, e := range rl.items {
			if e.seen.Before(cutoff) {
				delete(rl.items, k)
			}
		}
		rl.mu.Unlock()
	}
}

// Allow consumes one token for key and writes the RateLimit-* headers. It
// returns false (after writing a 429 problem) when the bucket is empty.
func (rl *RateLimiter) Allow(w http.ResponseWriter, r *http.Request, key string) bool {
	lim := rl.get(key)
	w.Header().Set("RateLimit-Limit", strconv.Itoa(rl.burst))
	if !lim.Allow() {
		res := lim.Reserve()
		delay := res.Delay()
		res.Cancel()
		secs := int(delay.Seconds()) + 1
		w.Header().Set("RateLimit-Remaining", "0")
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		httpproblem.Write(w, r, syncproto.CodeRateLimited, "", map[string]any{"retry_after": secs})
		return false
	}
	w.Header().Set("RateLimit-Remaining", strconv.Itoa(int(lim.Tokens())))
	return true
}

// Take consumes one token for key outside an HTTP request (the gRPC
// interceptors). When the bucket is empty it returns false and the time until
// the next token.
func (rl *RateLimiter) Take(key string) (bool, time.Duration) {
	lim := rl.get(key)
	if lim.Allow() {
		return true, 0
	}
	res := lim.Reserve()
	delay := res.Delay()
	res.Cancel()
	return false, delay
}

// ByIP applies the limiter per client address as resolved by ip. Health
// probes from direct internal callers are exempt: the orchestrator polls them
// from a few addresses and a throttled probe would take the pod out of
// rotation. Probes relayed by a proxy or coming from the internet are limited
// like any other request.
func (rl *RateLimiter) ByIP(ip ClientIP) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if (isProbe(r.URL.Path) && directInternal(r)) || rl.Allow(w, r, "ip:"+ip.Of(r)) {
				next.ServeHTTP(w, r)
			}
		})
	}
}

func isProbe(path string) bool {
	return path == BasePath+"/healthz" || path == BasePath+"/readyz"
}

// AuditClientIP stores the client address resolved by ip in the request
// context, where audit.Record picks it up for audit_log.ip.
func AuditClientIP(ip ClientIP) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(audit.WithClientIP(r.Context(), ip.Of(r))))
		})
	}
}

// ClientIP resolves the address of the client behind the trusted reverse
// proxies. X-Forwarded-For is read only when the TCP peer is trusted, and
// from the right: each trusted hop appended the address it saw, so the first
// untrusted entry is the client. Entries further left are client-supplied and
// never believed, which is what makes the header unspoofable.
type ClientIP struct {
	trusted []netip.Prefix
}

// NewClientIP trusts the proxies in the given networks (none: the peer is the client).
func NewClientIP(trusted []netip.Prefix) ClientIP { return ClientIP{trusted: trusted} }

// Of returns the client address without the port.
func (c ClientIP) Of(r *http.Request) string {
	return c.OfPeer(r.RemoteAddr, r.Header.Values("X-Forwarded-For"))
}

// OfPeer is Of for a TCP peer ("host:port") and the X-Forwarded-For values
// received from it (the gRPC server reads them from the request metadata).
func (c ClientIP) OfPeer(remote string, forwardedFor []string) string {
	peer, ok := parseHost(remote)
	if !ok {
		return remote
	}
	if !c.isTrusted(peer) {
		return peer.String()
	}
	hops := strings.Split(strings.Join(forwardedFor, ","), ",")
	client := peer
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break // malformed hop: stop at the last address a trusted proxy vouched for
		}
		client = a.Unmap()
		if !c.isTrusted(client) {
			break
		}
	}
	return client.String()
}

func (c ClientIP) isTrusted(a netip.Addr) bool {
	for _, p := range c.trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// parseHost extracts the address from "host:port" (or a bare host).
func parseHost(remote string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}
