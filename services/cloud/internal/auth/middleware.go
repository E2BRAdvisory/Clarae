package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"nodus/services/cloud/internal/api"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
)

// ErrSuspended is returned by a Provisioner when the account may not use the
// service (status suspended or deleted).
var ErrSuspended = errors.New("user suspended")

// Provisioner resolves token claims to a Principal, creating or updating the
// user record (just-in-time provisioning). Implemented by the users module.
type Provisioner interface {
	Provision(ctx context.Context, c Claims) (Principal, error)
}

// Limiter throttles authenticated callers per user id. Implemented by
// httpserver.RateLimiter; declared here to avoid an import cycle.
type Limiter interface {
	Allow(w http.ResponseWriter, r *http.Request, key string) bool
}

// Middleware authenticates routes that the OpenAPI contract protects with
// bearerAuth. The generated router stores api.BearerAuthScopes in the request
// context for those routes; routes without security (health probes) pass.
type Middleware struct {
	verifier    *Verifier
	provisioner Provisioner
	limiter     Limiter
	cacheTTL    time.Duration

	mu    sync.Mutex
	cache map[string]cachedPrincipal // keyed by subject
}

type cachedPrincipal struct {
	p       Principal
	expires time.Time
}

// NewMiddleware wires the verifier and provisioner. cacheTTL bounds how long
// a user's status is trusted without re-reading it (§1.3: 30 s); the limiter
// may be nil.
func NewMiddleware(v *Verifier, p Provisioner, limiter Limiter, cacheTTL time.Duration) *Middleware {
	return &Middleware{verifier: v, provisioner: p, limiter: limiter, cacheTTL: cacheTTL, cache: map[string]cachedPrincipal{}}
}

// Handler is the api.MiddlewareFunc.
func (m *Middleware) Handler(next http.Handler) http.Handler {
	protected := m.Protect(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Context().Value(api.BearerAuthScopes) == nil {
			next.ServeHTTP(w, r)
			return
		}
		protected.ServeHTTP(w, r)
	})
}

// Protect authenticates every request unconditionally. Routes that are not
// part of the generated OpenAPI router (tus uploads, the SSE stream) wrap
// themselves with it.
func (m *Middleware) Protect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		raw, ok := bearerToken(r)
		if !ok {
			w.Header().Set("WWW-Authenticate", `Bearer realm="nodus"`)
			httpproblem.Write(w, r, syncproto.CodeUnauthenticated, "missing bearer token", nil)
			return
		}
		p, exp, err := m.AuthenticateExp(ctx, raw)
		switch {
		case errors.Is(err, ErrSuspended):
			httpproblem.Write(w, r, syncproto.CodeUserSuspended, "account suspended", nil)
			return
		case errors.Is(err, ErrInvalidToken):
			zerolog.Ctx(ctx).Debug().Err(err).Msg("token rejected")
			w.Header().Set("WWW-Authenticate", `Bearer realm="nodus", error="invalid_token"`)
			httpproblem.Write(w, r, syncproto.CodeUnauthenticated, "invalid token", nil)
			return
		case err != nil:
			zerolog.Ctx(ctx).Error().Err(err).Msg("authentication failed")
			httpproblem.Write(w, r, syncproto.CodeInternal, "", nil)
			return
		}
		if m.limiter != nil && !m.limiter.Allow(w, r, "user:"+p.UserID.String()) {
			return
		}
		l := zerolog.Ctx(ctx).With().Str("user_id", p.UserID.String()).Logger()
		ctx = l.WithContext(WithTokenExpiry(WithPrincipal(ctx, p), exp))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Authenticate verifies a raw token and resolves its Principal, using the
// status cache. Shared by the HTTP middleware and the gRPC interceptor.
func (m *Middleware) Authenticate(ctx context.Context, raw string) (Principal, error) {
	p, _, err := m.AuthenticateExp(ctx, raw)
	return p, err
}

// AuthenticateExp is Authenticate that also returns the token expiry, which
// long-lived streams use to close themselves (§3.6).
func (m *Middleware) AuthenticateExp(ctx context.Context, raw string) (Principal, time.Time, error) {
	claims, err := m.verifier.Verify(ctx, raw)
	if err != nil {
		return Principal{}, time.Time{}, err
	}
	if p, ok := m.cached(claims.Subject); ok {
		return p, claims.Expiry, nil
	}
	p, err := m.provisioner.Provision(ctx, claims)
	if err != nil {
		return Principal{}, time.Time{}, err
	}
	m.store(p)
	return p, claims.Expiry, nil
}

// Invalidate drops the cached status of a user (called after suspension so
// the change applies immediately on this replica; other replicas expire it
// within cacheTTL).
func (m *Middleware) Invalidate(subject string) {
	m.mu.Lock()
	delete(m.cache, subject)
	m.mu.Unlock()
}

func (m *Middleware) cached(subject string) (Principal, bool) {
	if m.cacheTTL <= 0 {
		return Principal{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.cache[subject]
	if !ok || time.Now().After(c.expires) {
		delete(m.cache, subject)
		return Principal{}, false
	}
	return c.p, true
}

func (m *Middleware) store(p Principal) {
	if m.cacheTTL <= 0 {
		return
	}
	m.mu.Lock()
	m.cache[p.Subject] = cachedPrincipal{p: p, expires: time.Now().Add(m.cacheTTL)}
	m.mu.Unlock()
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(h[len(prefix):]), true
}
