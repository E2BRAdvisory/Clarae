package httpserver

import (
	"errors"
	"net/http"
	"runtime/debug"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/hlog"
	"golang.org/x/time/rate"

	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

// RequestLogger logs one line per request with the request id, status,
// duration and (when authenticated) the user id set by the auth middleware.
func RequestLogger(logger zerolog.Logger) func(http.Handler) http.Handler {
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
				Str("ip", r.RemoteAddr).
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

// ByIP applies the limiter per client address.
func (rl *RateLimiter) ByIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !rl.Allow(w, r, "ip:"+r.RemoteAddr) {
			return
		}
		next.ServeHTTP(w, r)
	})
}
