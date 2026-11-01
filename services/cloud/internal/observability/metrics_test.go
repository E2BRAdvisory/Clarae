package observability

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestMethodLabel(t *testing.T) {
	for in, want := range map[string]string{
		"GET": "GET", "HEAD": "HEAD", "POST": "POST", "PUT": "PUT", "PATCH": "PATCH", "DELETE": "DELETE",
		"OPTIONS": "OPTIONS", "get": "OTHER", "PROPFIND": "OTHER", "X-RANDOM-1234": "OTHER", "": "OTHER", "CONNECT": "OTHER",
	} {
		if got := methodLabel(in); got != want {
			t.Errorf("methodLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

// Arbitrary methods (any token is a valid HTTP method) must not create new series.
func TestHTTPMiddlewareBoundsTheMethodLabel(t *testing.T) {
	m := newMetrics()
	h := m.HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }))
	for _, method := range []string{"GET", "FOO1", "FOO2", "BAR", "GET"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, "/x", nil))
	}
	if n := testutil.CollectAndCount(m.requests); n != 2 {
		t.Fatalf("%d request series, want 2 (GET and OTHER)", n)
	}
	if got := testutil.ToFloat64(m.requests.WithLabelValues("unmatched", "OTHER", "404")); got != 3 {
		t.Fatalf("OTHER = %v, want 3", got)
	}
	if n := testutil.CollectAndCount(m.duration); n != 2 {
		t.Fatalf("%d duration series, want 2", n)
	}
}
