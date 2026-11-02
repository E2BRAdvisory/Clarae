package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

// ErrSuspended is returned by a Provisioner when the account may not use the
// service (status suspended or deleted).
var ErrSuspended = errors.New("user suspended")

// ErrIdentityConflict is returned by a Provisioner when the token's identity
// cannot be linked to an account: another live account already uses its
// e-mail address (typically an identity provider account deleted and
// recreated while its MemoBrain account still exists). An administrator
// resolves it; the provisioner never relinks accounts by e-mail.
var ErrIdentityConflict = errors.New("identity conflicts with an existing account")

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
	// epoch counts the invalidations. A provisioning stores its outcome only
	// if no invalidation happened while it read the database: otherwise a
	// suspension committed in between would be overwritten by the active
	// status read just before it, for a whole cacheTTL.
	epoch uint64
}

// cachedPrincipal is the outcome of one provisioning: a principal, or the
// error that refused it (suspension, identity conflict), which is cached for
// the same TTL so a refused client that keeps retrying costs no database work.
type cachedPrincipal struct {
	p       Principal
	err     error
	expires time.Time
}

// cacheSweepAt is the cache size above which a store first drops the expired
// entries, so subjects that stopped calling do not accumulate.
const cacheSweepAt = 4096

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
			w.Header().Set("WWW-Authenticate", `Bearer realm="memobrain"`)
			httpproblem.Write(w, r, syncproto.CodeUnauthenticated, "missing bearer token", nil)
			return
		}
		p, exp, err := m.AuthenticateExp(ctx, raw)
		switch {
		case errors.Is(err, ErrSuspended):
			httpproblem.Write(w, r, syncproto.CodeUserSuspended, "account suspended", nil)
			return
		case errors.Is(err, ErrIdentityConflict):
			httpproblem.Write(w, r, syncproto.CodeInvalidState, IdentityConflictDetail, nil)
			return
		case errors.Is(err, ErrInvalidToken):
			zerolog.Ctx(ctx).Debug().Err(err).Msg("token rejected")
			w.Header().Set("WWW-Authenticate", `Bearer realm="memobrain", error="invalid_token"`)
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
	if c, ok := m.cached(claims.Subject); ok {
		if c.err != nil {
			return Principal{}, time.Time{}, c.err
		}
		return c.p, claims.Expiry, nil
	}
	// When an invalidation lands during the provisioning, its result may
	// predate the change that caused it (a suspension): read once more, which
	// sees the committed change, and cache only a result no invalidation raced.
	var (
		p      Principal
		stored bool
	)
	for attempt := 0; attempt < 2 && !stored; attempt++ {
		epoch := m.currentEpoch()
		p, err = m.provisioner.Provision(ctx, claims)
		refused := errors.Is(err, ErrSuspended) || errors.Is(err, ErrIdentityConflict)
		if err != nil && !refused {
			return Principal{}, time.Time{}, err
		}
		stored = m.storeAt(epoch, claims.Subject, cachedPrincipal{p: p, err: err})
	}
	if err != nil {
		return Principal{}, time.Time{}, err
	}
	return p, claims.Expiry, nil
}

// IdentityConflictDetail is the problem detail of ErrIdentityConflict.
const IdentityConflictDetail = "this sign-in cannot be linked to your MemoBrain account: another account already uses " +
	"the same e-mail address; ask an administrator to resolve it"

// Invalidate drops the cached status of a user (called after a suspension, an
// activation or a role change, so it applies immediately on this replica;
// other replicas expire it within cacheTTL).
func (m *Middleware) Invalidate(subject string) {
	m.mu.Lock()
	delete(m.cache, subject)
	m.epoch++
	m.mu.Unlock()
}

func (m *Middleware) currentEpoch() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.epoch
}

func (m *Middleware) cached(subject string) (cachedPrincipal, bool) {
	if m.cacheTTL <= 0 {
		return cachedPrincipal{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.cache[subject]
	if !ok || time.Now().After(c.expires) {
		delete(m.cache, subject)
		return cachedPrincipal{}, false
	}
	return c, true
}

// storeAt caches c unless an invalidation happened since epoch was read; it
// reports whether the result is current (cached, or the cache is off).
func (m *Middleware) storeAt(epoch uint64, subject string, c cachedPrincipal) bool {
	now := time.Now()
	c.expires = now.Add(m.cacheTTL)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.epoch != epoch {
		return false
	}
	if m.cacheTTL <= 0 {
		return true
	}
	if len(m.cache) >= cacheSweepAt {
		for k, e := range m.cache {
			if now.After(e.expires) {
				delete(m.cache, k)
			}
		}
	}
	m.cache[subject] = c
	return true
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(h[len(prefix):]), true
}
