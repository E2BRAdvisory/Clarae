package httpserver

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"memobrain/services/cloud/internal/audit"
)

func TestAuditClientIPUsesTheTrustedProxyRule(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	for _, c := range []struct {
		name    string
		trusted []netip.Prefix
		remote  string
		xff     string
		want    string
	}{
		{"direct client, forged header ignored", nil, "198.51.100.4:5555", "203.0.113.9", "198.51.100.4"},
		{"behind the trusted proxy", proxy, "10.1.2.3:443", "198.51.100.66, 203.0.113.7", "203.0.113.7"},
		{"untrusted peer claiming a proxy", proxy, "192.0.2.10:443", "203.0.113.7", "192.0.2.10"},
		{"IPv6 client", nil, "[2001:db8::5]:443", "", "2001:db8::5"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var got string
			h := AuditClientIP(NewClientIP(c.trusted))(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				if a, ok := audit.ClientIP(r.Context()); ok {
					got = a.String()
				}
			}))
			req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/users", nil)
			req.RemoteAddr = c.remote
			if c.xff != "" {
				req.Header.Set("X-Forwarded-For", c.xff)
			}
			h.ServeHTTP(httptest.NewRecorder(), req)
			if got != c.want {
				t.Fatalf("audit ip %q, want %q", got, c.want)
			}
		})
	}
}
