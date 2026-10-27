package httpserver

import "net/http"

// internalOnly serves h only to direct callers. Prometheus scrapes the pods inside the cluster,
// while every reverse proxy or ingress in front of the service adds X-Forwarded-For (or
// Forwarded) to what it relays: such requests come from outside and get a 404, so /metrics
// is never reachable through the public ingress even though it is not authenticated.
func internalOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Forwarded") != "" {
			http.NotFound(w, r)
			return
		}
		h.ServeHTTP(w, r)
	})
}
