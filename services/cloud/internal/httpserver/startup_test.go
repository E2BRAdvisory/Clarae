package httpserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStartupAnswersProbesUntilReady(t *testing.T) {
	metrics := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("go_goroutines 1")) })
	s := NewStartup("v1", metrics)
	probe := func(path string, headers ...string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "10.1.2.3:4567"
		for i := 0; i+1 < len(headers); i += 2 {
			req.Header.Set(headers[i], headers[i+1])
		}
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec
	}
	body := func(rec *httptest.ResponseRecorder) map[string]any {
		var m map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
			t.Fatalf("body %q: %v", rec.Body.String(), err)
		}
		return m
	}

	if s.Started() {
		t.Fatal("started before Ready")
	}
	if rec := probe(BasePath + "/healthz"); rec.Code != http.StatusOK || body(rec)["status"] != "ok" || body(rec)["version"] != "v1" {
		t.Fatalf("/healthz while starting: %d %s", rec.Code, rec.Body)
	}
	rec := probe(BasePath + "/readyz")
	if rec.Code != http.StatusServiceUnavailable || body(rec)["status"] != "unavailable" {
		t.Fatalf("/readyz while starting: %d %s", rec.Code, rec.Body)
	}
	if checks, _ := body(rec)["checks"].(map[string]any); checks["startup"] == nil {
		t.Fatalf("/readyz for a direct internal caller lists no startup check: %s", rec.Body)
	}
	if rec := probe(BasePath+"/readyz", "X-Forwarded-For", "203.0.113.9"); rec.Code != http.StatusServiceUnavailable || body(rec)["checks"] != nil {
		t.Fatalf("/readyz relayed by a proxy must carry no details: %d %s", rec.Code, rec.Body)
	}
	rec = probe(BasePath + "/me")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" ||
		!strings.HasPrefix(rec.Header().Get("Content-Type"), "application/problem+json") {
		t.Fatalf("API while starting: %d %v %s", rec.Code, rec.Header(), rec.Body)
	}
	if p := body(rec); p["status"] != float64(http.StatusServiceUnavailable) || p["code"] == "" {
		t.Fatalf("problem while starting: %s", rec.Body)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("security headers missing while starting")
	}
	if rec := probe("/metrics"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "go_goroutines") {
		t.Fatalf("/metrics while starting: %d", rec.Code)
	}
	if rec := probe("/metrics", "X-Forwarded-For", "203.0.113.9"); rec.Code != http.StatusNotFound {
		t.Fatalf("/metrics relayed by a proxy: %d", rec.Code)
	}

	s.Ready(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Path", r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	}))
	if !s.Started() {
		t.Fatal("not started after Ready")
	}
	for _, path := range []string{BasePath + "/healthz", BasePath + "/readyz", BasePath + "/me", "/metrics"} {
		if rec := probe(path); rec.Code != http.StatusTeapot || rec.Header().Get("X-Path") != path {
			t.Fatalf("%s after Ready: %d %v", path, rec.Code, rec.Header())
		}
	}
}

func TestStartupWithoutMetrics(t *testing.T) {
	s := NewStartup("v1", nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/metrics without a metrics handler: %d", rec.Code)
	}
}
