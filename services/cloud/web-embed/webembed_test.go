package webembed

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testHandler() http.Handler {
	return Handler(Options{
		Issuer: "https://id.example.com:8443/realms/nodus",
		FS: fstest.MapFS{
			"index.html":      {Data: []byte("<html>app</html>")},
			"assets/app-1.js": {Data: []byte("console.log(1)")},
			"favicon.svg":     {Data: []byte("<svg/>")},
		},
	})
}

func get(h http.Handler, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestSPAFallbackServesIndexWithoutCache(t *testing.T) {
	for _, p := range []string{"/", "/vaults", "/shares/123/grants", "/admin"} {
		rec := get(testHandler(), http.MethodGet, p)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "app") {
			t.Fatalf("%s: code %d body %q", p, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control = %q", p, got)
		}
	}
}

func TestHashedAssetsAreImmutable(t *testing.T) {
	rec := get(testHandler(), http.MethodGet, "/assets/app-1.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("code %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if rec2 := get(testHandler(), http.MethodGet, "/favicon.svg"); rec2.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("non-hashed file must not be immutable")
	}
}

func TestMissingFileWithExtensionIs404(t *testing.T) {
	for _, p := range []string{"/assets/missing.js", "/robots.txt"} {
		if rec := get(testHandler(), http.MethodGet, p); rec.Code != http.StatusNotFound {
			t.Fatalf("%s: code %d", p, rec.Code)
		}
	}
}

func TestAPIPathsAreNotShadowed(t *testing.T) {
	for _, p := range []string{"/api", "/api/v1/unknown", "/api/v1/vaults/"} {
		rec := get(testHandler(), http.MethodGet, p)
		if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "app") {
			t.Fatalf("%s: code %d body %q", p, rec.Code, rec.Body.String())
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	rec := get(testHandler(), http.MethodGet, "/")
	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{
		"default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
		"connect-src 'self' https://id.example.com:8443;", "frame-ancestors 'none'",
		"base-uri 'none'", "form-action 'self'", "object-src 'none'",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q lacks %q", csp, want)
		}
	}
	if strings.Contains(csp, "realms") || strings.Contains(csp, "unsafe") {
		t.Errorf("CSP must only carry the issuer origin and no unsafe source: %q", csp)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Referrer-Policy") == "" {
		t.Errorf("missing security headers: %v", rec.Header())
	}
	if rec.Header().Get("Strict-Transport-Security") != "" {
		t.Errorf("HSTS must not be set by the app")
	}
}

func TestCSPWithoutIssuerIsSelfOnly(t *testing.T) {
	if got := CSP(""); !strings.Contains(got, "connect-src 'self';") {
		t.Fatalf("CSP = %q", got)
	}
}

func TestMethodsAndHead(t *testing.T) {
	if rec := get(testHandler(), http.MethodPost, "/"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", rec.Code)
	}
	if rec := get(testHandler(), http.MethodHead, "/"); rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("HEAD: %d len %d", rec.Code, rec.Body.Len())
	}
}

func TestEmbeddedFSIsServed(t *testing.T) {
	rec := get(Handler(Options{}), http.MethodGet, "/anything")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<html") {
		t.Fatalf("code %d", rec.Code)
	}
}
