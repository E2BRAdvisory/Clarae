package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// testDeviceID is the id the fake cloud gives the registered device.
const testDeviceID = "0190a0a0-0000-7000-8000-0000000000d1"

// fakeCloud serves /client-config, /me and /me/devices.
func newFakeCloud(t *testing.T, issuer string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/client-config", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "desktop_client_id": "clarae-desktop", "audience": "clarae-api", "grpc_endpoint": "127.0.0.1:18082", "api_version": "test"})
	})
	authed := func(w http.ResponseWriter, r *http.Request) bool {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer at-") {
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"type":"x","title":"x","status":401,"code":"UNAUTHENTICATED"}`))
			return false
		}
		return true
	}
	mux.HandleFunc("/api/v1/me", func(w http.ResponseWriter, r *http.Request) {
		if !authed(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "0190a0a0-0000-7000-8000-0000000000a1", "username": "user1", "email": "user1@clarae.local", "display_name": "Uno", "role": "user", "status": "active", "quota_bytes": 1, "used_bytes": 0, "config_version": 0, "created_at": time.Now()})
	})
	mux.HandleFunc("/api/v1/me/devices", func(w http.ResponseWriter, r *http.Request) {
		if !authed(w, r) {
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": testDeviceID, "name": "x", "platform": "macos", "created_at": time.Now()})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}
