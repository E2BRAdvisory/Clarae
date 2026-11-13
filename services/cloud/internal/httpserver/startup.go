package httpserver

import (
	"encoding/json"
	"net/http"
	"sync/atomic"

	"clarae/services/cloud/internal/api"
	"clarae/services/cloud/internal/httpproblem"
	"clarae/shared/syncproto"
)

// Startup is the handler of the API listener, which opens before the slow
// part of the startup: the database migrations (which may wait minutes for
// another replica's migration lock) and the OIDC discovery (which retries
// while the identity provider starts). Until Ready is called /healthz answers
// 200, so the orchestrator's startup and liveness probes do not restart the
// process in the middle of a migration, /readyz answers 503, so no traffic is
// routed to it, and every other request gets a 503 problem with Retry-After.
// After Ready every request goes to the API router.
type Startup struct {
	version string
	next    atomic.Pointer[http.Handler]
	metrics http.Handler
}

// NewStartup returns the handler in the starting state; metrics, when not
// nil, serves /metrics meanwhile (to direct callers only, as the router does).
func NewStartup(version string, metrics http.Handler) *Startup {
	s := &Startup{version: version}
	if metrics != nil {
		s.metrics = internalOnly(metrics)
	}
	return s
}

// Ready hands every following request to h.
func (s *Startup) Ready(h http.Handler) { s.next.Store(&h) }

// Started reports whether Ready was called.
func (s *Startup) Started() bool { return s.next.Load() != nil }

// ServeHTTP implements http.Handler.
func (s *Startup) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h := s.next.Load(); h != nil {
		(*h).ServeHTTP(w, r)
		return
	}
	SecurityHeaders(http.HandlerFunc(s.starting)).ServeHTTP(w, r)
}

// starting answers while the startup is in progress.
func (s *Startup) starting(w http.ResponseWriter, r *http.Request) {
	v := s.version
	switch {
	case r.URL.Path == BasePath+"/healthz":
		writeHealth(w, http.StatusOK, api.Health{Status: api.HealthStatusOk, Version: &v})
	case r.URL.Path == BasePath+"/readyz":
		health := api.Health{Status: api.HealthStatusUnavailable, Version: &v}
		if directInternal(r) {
			checks := map[string]string{"startup": "in progress"}
			health.Checks = &checks
		}
		writeHealth(w, http.StatusServiceUnavailable, health)
	case r.URL.Path == "/metrics" && s.metrics != nil:
		s.metrics.ServeHTTP(w, r)
	default:
		p := httpproblem.New(r, syncproto.CodeInternal, "the service is starting", nil)
		p.Title, p.Status = "Service unavailable", http.StatusServiceUnavailable
		w.Header().Set("Content-Type", "application/problem+json")
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(p.Status)
		_ = json.NewEncoder(w).Encode(p)
	}
}

func writeHealth(w http.ResponseWriter, status int, h api.Health) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(h)
}
