// Package system serves the liveness and readiness probes and the public
// client bootstrap document (GET /client-config).
package system

import (
	"context"
	"sync"
	"time"

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
}

// Name implements Checker.
func (c CheckerFunc) Name() string { return c.N }

// Check implements Checker.
func (c CheckerFunc) Check(ctx context.Context) error { return c.F(ctx) }

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
	version  string
	client   ClientConfig
	checkers []Checker
}

// NewHTTP registers the dependencies probed by /readyz.
func NewHTTP(version string, client ClientConfig, checkers ...Checker) *HTTP {
	return &HTTP{version: version, client: client, checkers: checkers}
}

// Healthz implements GET /healthz: the process is alive.
func (h *HTTP) Healthz(_ context.Context, _ api.HealthzRequestObject) (api.HealthzResponseObject, error) {
	v := h.version
	return api.Healthz200JSONResponse{Status: api.HealthStatusOk, Version: &v}, nil
}

// Readyz implements GET /readyz: every dependency answers within 3 s.
func (h *HTTP) Readyz(ctx context.Context, _ api.ReadyzRequestObject) (api.ReadyzResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	checks := make(map[string]string, len(h.checkers))
	var mu sync.Mutex
	var wg sync.WaitGroup
	healthy := true
	for _, c := range h.checkers {
		wg.Add(1)
		go func(c Checker) {
			defer wg.Done()
			err := c.Check(ctx)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				checks[c.Name()] = err.Error()
				healthy = false
				return
			}
			checks[c.Name()] = "ok"
		}(c)
	}
	wg.Wait()

	v := h.version
	if !healthy {
		return api.Readyz503JSONResponse{Status: api.HealthStatusUnavailable, Checks: &checks, Version: &v}, nil
	}
	return api.Readyz200JSONResponse{Status: api.HealthStatusOk, Checks: &checks, Version: &v}, nil
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
