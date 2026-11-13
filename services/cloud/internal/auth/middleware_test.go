package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/auth/authtest"
)

// countingProvisioner returns a scripted outcome and counts the calls.
type countingProvisioner struct {
	mu    sync.Mutex
	calls int
	err   error
	role  Role
}

func (p *countingProvisioner) Provision(_ context.Context, c Claims) (Principal, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	if p.err != nil {
		return Principal{}, p.err
	}
	return Principal{UserID: uuid.NewSHA1(uuid.Nil, []byte(c.Subject)), Subject: c.Subject, Role: p.role, Status: StatusActive}, nil
}

func (p *countingProvisioner) set(role Role, err error) {
	p.mu.Lock()
	p.role, p.err = role, err
	p.mu.Unlock()
}

func (p *countingProvisioner) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func newTestMiddleware(t *testing.T, ttl time.Duration) (*Middleware, *countingProvisioner, *authtest.Issuer) {
	t.Helper()
	iss := authtest.New(t)
	v, err := NewVerifier(context.Background(), iss.URL(), "clarae-api", nil)
	if err != nil {
		t.Fatal(err)
	}
	p := &countingProvisioner{role: RoleUser}
	return NewMiddleware(v, p, nil, ttl), p, iss
}

func TestMiddlewareCachesThePrincipalForTheTTL(t *testing.T) {
	m, p, iss := newTestMiddleware(t, 200*time.Millisecond)
	ctx := context.Background()
	tok := iss.Token(t, authtest.TokenOptions{Subject: "ada"})
	for range 3 {
		if _, err := m.Authenticate(ctx, tok); err != nil {
			t.Fatal(err)
		}
	}
	if p.count() != 1 {
		t.Fatalf("provisioned %d times within the TTL, want 1", p.count())
	}
	// Another token of the same subject reuses the entry (keyed by subject).
	if _, err := m.Authenticate(ctx, iss.Token(t, authtest.TokenOptions{Subject: "ada", Username: "other"})); err != nil || p.count() != 1 {
		t.Fatalf("calls %d (%v)", p.count(), err)
	}
	time.Sleep(250 * time.Millisecond)
	if _, err := m.Authenticate(ctx, tok); err != nil || p.count() != 2 {
		t.Fatalf("after the TTL: calls %d (%v), want 2", p.count(), err)
	}
}

func TestMiddlewareInvalidateAppliesARoleChangeAtOnce(t *testing.T) {
	m, p, iss := newTestMiddleware(t, time.Hour)
	ctx := context.Background()
	tok := iss.Token(t, authtest.TokenOptions{Subject: "ada", Roles: []string{"clarae-admin"}})
	p.set(RoleAdmin, nil)
	if pr, err := m.Authenticate(ctx, tok); err != nil || !pr.IsAdmin() {
		t.Fatalf("%+v %v", pr, err)
	}
	// The administrator demotes her: the provisioner (the database) now says user.
	p.set(RoleUser, nil)
	if pr, _ := m.Authenticate(ctx, tok); !pr.IsAdmin() {
		t.Fatal("without Invalidate the cached role holds for the TTL")
	}
	m.Invalidate("ada")
	if pr, err := m.Authenticate(ctx, tok); err != nil || pr.IsAdmin() {
		t.Fatalf("after Invalidate the old token must get the database role: %+v %v", pr, err)
	}
}

func TestMiddlewareCachesRefusals(t *testing.T) {
	for name, refusal := range map[string]error{"suspended": ErrSuspended, "identity conflict": ErrIdentityConflict} {
		t.Run(name, func(t *testing.T) {
			m, p, iss := newTestMiddleware(t, time.Hour)
			ctx := context.Background()
			tok := iss.Token(t, authtest.TokenOptions{Subject: "ada"})
			p.set(RoleUser, refusal)
			for range 5 {
				if _, err := m.Authenticate(ctx, tok); !errors.Is(err, refusal) {
					t.Fatalf("got %v, want %v", err, refusal)
				}
			}
			if p.count() != 1 {
				t.Fatalf("a refused client cost %d provisionings, want 1 per TTL", p.count())
			}
			// Activation invalidates: the next request sees the new status.
			p.set(RoleUser, nil)
			m.Invalidate("ada")
			if _, err := m.Authenticate(ctx, tok); err != nil {
				t.Fatalf("after Invalidate: %v", err)
			}
		})
	}
}

func TestMiddlewareDoesNotCacheInternalErrors(t *testing.T) {
	m, p, iss := newTestMiddleware(t, time.Hour)
	ctx := context.Background()
	tok := iss.Token(t, authtest.TokenOptions{Subject: "ada"})
	p.set(RoleUser, errors.New("database down"))
	_, _ = m.Authenticate(ctx, tok)
	p.set(RoleUser, nil)
	if _, err := m.Authenticate(ctx, tok); err != nil || p.count() != 2 {
		t.Fatalf("a transient failure must not stick: calls %d (%v)", p.count(), err)
	}
}

func TestMiddlewareZeroTTLDisablesTheCache(t *testing.T) {
	m, p, iss := newTestMiddleware(t, 0)
	tok := iss.Token(t, authtest.TokenOptions{Subject: "ada"})
	for range 3 {
		_, _ = m.Authenticate(context.Background(), tok)
	}
	if p.count() != 3 {
		t.Fatalf("calls %d, want 3", p.count())
	}
}

func TestProtectMapsErrorsToProblems(t *testing.T) {
	cases := map[string]struct {
		err    error
		token  string
		status int
		code   string
	}{
		"missing token":     {status: http.StatusUnauthorized, code: "UNAUTHENTICATED"},
		"invalid token":     {token: "not.a.jwt", status: http.StatusUnauthorized, code: "UNAUTHENTICATED"},
		"suspended":         {err: ErrSuspended, status: http.StatusForbidden, code: "USER_SUSPENDED"},
		"identity conflict": {err: ErrIdentityConflict, status: http.StatusConflict, code: "INVALID_STATE"},
		"internal":          {err: errors.New("boom"), status: http.StatusInternalServerError, code: "INTERNAL"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			m, p, iss := newTestMiddleware(t, time.Hour)
			p.set(RoleUser, c.err)
			reached := false
			h := m.Protect(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
			req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
			switch {
			case c.token != "":
				req.Header.Set("Authorization", "Bearer "+c.token)
			case name != "missing token":
				req.Header.Set("Authorization", "Bearer "+iss.Token(t, authtest.TokenOptions{Subject: "ada"}))
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if reached || rec.Code != c.status || !strings.Contains(rec.Body.String(), `"`+c.code+`"`) {
				t.Fatalf("reached=%v status=%d body=%s, want %d %s", reached, rec.Code, rec.Body.String(), c.status, c.code)
			}
		})
	}
}

func TestMiddlewareSweepsExpiredEntries(t *testing.T) {
	m := &Middleware{cacheTTL: time.Millisecond, cache: map[string]cachedPrincipal{}}
	for i := range cacheSweepAt {
		m.cache[uuid.NewString()] = cachedPrincipal{expires: time.Now().Add(-time.Duration(i+1) * time.Second)}
	}
	m.storeAt(0, "fresh", cachedPrincipal{})
	if len(m.cache) != 1 {
		t.Fatalf("expired entries kept: %d", len(m.cache))
	}
}

// hookProvisioner runs a hook during the provisioning, between the database
// read and the cache store of the middleware.
type hookProvisioner struct {
	mu     sync.Mutex
	status Status
	calls  int
	during func()
}

func (p *hookProvisioner) Provision(_ context.Context, c Claims) (Principal, error) {
	p.mu.Lock()
	p.calls++
	st, during := p.status, p.during
	p.during = nil
	p.mu.Unlock()
	if during != nil {
		during() // the read above already happened: what follows races it
	}
	if st == StatusSuspended {
		return Principal{}, ErrSuspended
	}
	return Principal{UserID: uuid.NewSHA1(uuid.Nil, []byte(c.Subject)), Subject: c.Subject, Role: RoleUser, Status: st}, nil
}

// Regression (M12): a suspension committed and invalidated while a request
// was provisioning left the active principal it had read in the cache for the
// whole TTL. The middleware reads again and caches the suspension.
func TestMiddlewareInvalidateDuringProvisioningWins(t *testing.T) {
	iss := authtest.New(t)
	v, err := NewVerifier(context.Background(), iss.URL(), "clarae-api", nil)
	if err != nil {
		t.Fatal(err)
	}
	p := &hookProvisioner{status: StatusActive}
	m := NewMiddleware(v, p, nil, time.Hour)
	p.during = func() {
		p.mu.Lock()
		p.status = StatusSuspended
		p.mu.Unlock()
		m.Invalidate("ada")
	}
	tok := iss.Token(t, authtest.TokenOptions{Subject: "ada"})
	if _, err := m.Authenticate(context.Background(), tok); !errors.Is(err, ErrSuspended) {
		t.Fatalf("the request racing the suspension got %v, want ErrSuspended", err)
	}
	if _, err := m.Authenticate(context.Background(), tok); !errors.Is(err, ErrSuspended) {
		t.Fatalf("the next request got %v, want ErrSuspended", err)
	}
	if p.calls != 2 {
		t.Fatalf("provisioned %d times, want 2 (one retry, then cached)", p.calls)
	}
}

func TestMiddlewareDoesNotCacheAResultRacedTwice(t *testing.T) {
	m := &Middleware{cacheTTL: time.Hour, cache: map[string]cachedPrincipal{}}
	epoch := m.currentEpoch()
	m.Invalidate("bob") // any subject: the epoch is global
	if m.storeAt(epoch, "ada", cachedPrincipal{}) {
		t.Fatal("a result read before an invalidation was stored")
	}
	if _, ok := m.cached("ada"); ok {
		t.Fatal("stale entry cached")
	}
	if !m.storeAt(m.currentEpoch(), "ada", cachedPrincipal{}) {
		t.Fatal("a current result was not stored")
	}
}
