package httpserver

import (
	"net/http"
	"net/netip"

	"memobrain/services/cloud/internal/system"
)

// internalOnly serves h only to direct callers. Prometheus scrapes the pods inside the cluster,
// while every reverse proxy or ingress in front of the service adds X-Forwarded-For (or
// Forwarded) to what it relays: such requests come from outside and get a 404, so /metrics
// is never reachable through the public ingress even though it is not authenticated.
func internalOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if proxied(r) {
			http.NotFound(w, r)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// proxied reports whether a reverse proxy relayed the request.
func proxied(r *http.Request) bool {
	return r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("Forwarded") != ""
}

// cgnat is the shared address space (RFC 6598) some clusters use for pods and nodes.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// directInternal reports whether the request comes straight (no proxy) from an address of the
// local network: loopback, private (RFC 1918, ULA), link-local or shared. That is where the
// orchestrator's probes come from (kubelet on the node, the compose healthcheck in the
// container); a client on the internet, or anything relayed by the ingress, is not.
func directInternal(r *http.Request) bool {
	if proxied(r) {
		return false
	}
	a, ok := parseHost(r.RemoteAddr)
	return ok && (a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || cgnat.Contains(a))
}

// probeDetails lets the readiness probe list the result of each check for direct internal
// callers only; everyone else gets the bare status (system.WithDetails).
func probeDetails(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isProbe(r.URL.Path) && directInternal(r) {
			r = r.WithContext(system.WithDetails(r.Context()))
		}
		next.ServeHTTP(w, r)
	})
}
