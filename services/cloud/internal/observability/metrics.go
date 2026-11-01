// Package observability exposes RED metrics for Prometheus. Tracing (OpenTelemetry)
// is added in M7 hardening once the exporter stack is chosen.
package observability

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds the registered collectors.
type Metrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	inflight prometheus.Gauge
}

// New registers the HTTP collectors on the default registry.
func New() *Metrics {
	m := newMetrics()
	prometheus.MustRegister(m.requests, m.duration, m.inflight)
	return m
}

func newMetrics() *Metrics {
	return &Metrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "memobrain", Subsystem: "http", Name: "requests_total",
			Help: "HTTP requests by route pattern, method and status.",
		}, []string{"route", "method", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: "memobrain", Subsystem: "http", Name: "request_duration_seconds",
			Help:    "HTTP request latency by route pattern and method.",
			Buckets: []float64{.005, .01, .025, .05, .1, .2, .5, 1, 2.5, 5, 10},
		}, []string{"route", "method"}),
		inflight: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "memobrain", Subsystem: "http", Name: "inflight_requests",
			Help: "HTTP requests currently being served.",
		}),
	}
}

// HTTPMiddleware records one observation per request, labelled with the chi
// route pattern (not the raw path) to keep cardinality bounded.
func (m *Metrics) HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.inflight.Inc()
		defer m.inflight.Dec()
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		method := methodLabel(r.Method)
		m.requests.WithLabelValues(route, method, strconv.Itoa(ww.Status())).Inc()
		m.duration.WithLabelValues(route, method).Observe(time.Since(start).Seconds())
	})
}

// methodLabel maps the request method to a closed set: the middleware runs before routing and
// net/http accepts any token as a method, so the raw value would let clients mint label values.
func methodLabel(m string) string {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return m
	}
	return "OTHER"
}
