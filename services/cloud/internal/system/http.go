// Package system serves the liveness and readiness probes and the public
// client bootstrap document (GET /client-config).
package system

import (
	"context"
	"maps"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/sync/singleflight"

	"memobrain/services/cloud/internal/api"
)

// Checker reports the health of one dependency.
type Checker interface {
	Name() string
	Check(ctx context.Context) error
}

// CheckerFunc adapts a function to Checker.
type CheckerFunc struct {
	N string
	F func(ctx context.Context) error
	// Live checks run on every probe instead of being cached with the
	// dependency checks: they must be cheap (the shutdown drain flag).
	Live bool
}

// Name implements Checker.
func (c CheckerFunc) Name() string { return c.N }

// Check implements Checker.
func (c CheckerFunc) Check(ctx context.Context) error { return c.F(ctx) }

// IsLive implements the optional interface of the checks that are never cached.
func (c CheckerFunc) IsLive() bool { return c.Live }

func isLive(c Checker) bool {
	l, ok := c.(interface{ IsLive() bool })
	return ok && l.IsLive()
}

// ReadyCacheTTL is how long the result of the dependency checks is reused:
// however many probes arrive, the database and the object store are asked at
// most once per period, and concurrent probes share one round of checks.
const ReadyCacheTTL = 2 * time.Second

type detailsKey struct{}

// WithDetails marks a probe request whose /readyz answer may list the result
// of each check. The HTTP layer sets it only for direct callers inside the
// network (the orchestrator, an operator on the node): an answer relayed to
// the internet says only ok or unavailable, and the details go to the log.
func WithDetails(ctx context.Context) context.Context {
	return context.WithValue(ctx, detailsKey{}, true)
}

func detailsAllowed(ctx context.Context) bool {
	v, _ := ctx.Value(detailsKey{}).(bool)
	return v
}

// ClientConfig is what a client needs to know to start a login.
type ClientConfig struct {
	Issuer          string
	DesktopClientID string
	WebClientID     string
	Audience        string
	GRPCEndpoint    string
}

// HTTP implements /healthz, /readyz and /client-config.
type HTTP struct {
	version string
	client  ClientConfig
	// deps are cached for ReadyCacheTTL; live checks run on every probe.
	deps, live []Checker
	log        zerolog.Logger
	now        func() time.Time

	group    singleflight.Group
	mu       sync.Mutex
	cached   map[string]error
	cachedAt time.Time
}

// NewHTTP registers the dependencies probed by /readyz.
func NewHTTP(version string, client ClientConfig, checkers ...Checker) *HTTP {
	h := &HTTP{version: version, client: client, log: zerolog.Nop(), now: time.Now}
	for _, c := range checkers {
		if isLive(c) {
			h.live = append(h.live, c)
		} else {
			h.deps = append(h.deps, c)
		}
	}
	return h
}

// WithLogger logs the failed readiness checks (their details are not returned
// to callers outside the network).
func (h *HTTP) WithLogger(l zerolog.Logger) *HTTP {
	h.log = l
	return h
}

// Healthz implements GET /healthz: the process is alive.
func (h *HTTP) Healthz(_ context.Context, _ api.HealthzRequestObject) (api.HealthzResponseObject, error) {
	v := h.version
	return api.Healthz200JSONResponse{Status: api.HealthStatusOk, Version: &v}, nil
}

// Readyz implements GET /readyz: every dependency answers within 3 s. The
// dependency results are cached for ReadyCacheTTL and shared by concurrent
// probes, so the endpoint cannot be used to multiply load on the database
// and the object store.
func (h *HTTP) Readyz(ctx context.Context, _ api.ReadyzRequestObject) (api.ReadyzResponseObject, error) {
	results := h.dependencies(ctx)
	for _, c := range h.live {
		results[c.Name()] = c.Check(ctx)
	}
	healthy := true
	checks := make(map[string]string, len(results))
	for name, err := range results {
		if err != nil {
			healthy = false
			checks[name] = err.Error()
			continue
		}
		checks[name] = "ok"
	}

	v := h.version
	var details *map[string]string
	if detailsAllowed(ctx) {
		details = &checks
	}
	if !healthy {
		return api.Readyz503JSONResponse{Status: api.HealthStatusUnavailable, Checks: details, Version: &v}, nil
	}
	return api.Readyz200JSONResponse{Status: api.HealthStatusOk, Checks: details, Version: &v}, nil
}

// dependencies returns a copy of the cached dependency results, running the
// checks again (once, whatever the number of concurrent callers) when the
// cache expired.
func (h *HTTP) dependencies(ctx context.Context) map[string]error {
	h.mu.Lock()
	if h.cached != nil && h.now().Sub(h.cachedAt) < ReadyCacheTTL {
		out := maps.Clone(h.cached)
		h.mu.Unlock()
		return out
	}
	h.mu.Unlock()
	// The round of checks belongs to every waiting probe: it must not end
	// when the probe that started it goes away.
	v, _, _ := h.group.Do("readyz", func() (any, error) {
		res := h.runChecks(context.WithoutCancel(ctx))
		h.mu.Lock()
		h.cached, h.cachedAt = res, h.now()
		h.mu.Unlock()
		for name, err := range res {
			if err != nil {
				h.log.Warn().Err(err).Str("check", name).Msg("readiness check failed")
			}
		}
		return res, nil
	})
	return maps.Clone(v.(map[string]error))
}

func (h *HTTP) runChecks(ctx context.Context) map[string]error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	res := make(map[string]error, len(h.deps))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range h.deps {
		wg.Go(func() {
			err := c.Check(ctx)
			mu.Lock()
			defer mu.Unlock()
			res[c.Name()] = err
		})
	}
	wg.Wait()
	return res
}

// GetClientConfig implements GET /client-config.
func (h *HTTP) GetClientConfig(_ context.Context, _ api.GetClientConfigRequestObject) (api.GetClientConfigResponseObject, error) {
	return api.GetClientConfig200JSONResponse{
		Issuer:          h.client.Issuer,
		DesktopClientId: h.client.DesktopClientID,
		WebClientId:     h.client.WebClientID,
		Audience:        h.client.Audience,
		GrpcEndpoint:    h.client.GRPCEndpoint,
		ApiVersion:      h.version,
	}, nil
}
