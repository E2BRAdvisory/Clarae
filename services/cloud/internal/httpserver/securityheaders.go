package httpserver

import "net/http"

// SecurityHeaders sets the headers every response of the service carries, API and
// SPA alike: no MIME sniffing (a JSON or blob response is never reinterpreted as
// script or HTML), no referrer leakage and no framing. The SPA handler adds its own
// Content-Security-Policy on top (web-embed).
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
