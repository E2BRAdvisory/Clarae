package system

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"memobrain/services/cloud/internal/api"
)

func TestClientConfigExposesBothClientIDs(t *testing.T) {
	h := NewHTTP("v1", ClientConfig{
		Issuer: "https://id.example.com/realms/memobrain", DesktopClientID: "memobrain-desktop", WebClientID: "memobrain-web",
		Audience: "memobrain-api", GRPCEndpoint: "host:18082",
	})
	res, err := h.GetClientConfig(context.Background(), api.GetClientConfigRequestObject{})
	if err != nil {
		t.Fatal(err)
	}
	cc, ok := res.(api.GetClientConfig200JSONResponse)
	if !ok {
		t.Fatalf("unexpected response %T", res)
	}
	if cc.WebClientId != "memobrain-web" || cc.DesktopClientId != "memobrain-desktop" || cc.Issuer == "" || cc.ApiVersion != "v1" {
		t.Fatalf("client config: %+v", cc)
	}
}

func TestReadyzCachesAndSharesTheDependencyChecks(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	slow := CheckerFunc{N: "database", F: func(context.Context) error {
		calls.Add(1)
		<-release
		return nil
	}}
	h := NewHTTP("v1", ClientConfig{}, slow)
	now := time.Unix(1000, 0)
	h.now = func() time.Time { return now }

	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if _, ok := mustReadyz(t, h, context.Background()).(api.Readyz200JSONResponse); !ok {
				t.Error("not ready")
			}
		})
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := calls.Load(); n != 1 {
		t.Fatalf("20 concurrent probes ran the check %d times, want 1", n)
	}
	mustReadyz(t, h, context.Background())
	if n := calls.Load(); n != 1 {
		t.Fatalf("a probe within the TTL ran the check again (%d)", n)
	}
	now = now.Add(ReadyCacheTTL)
	mustReadyz(t, h, context.Background())
	if n := calls.Load(); n != 2 {
		t.Fatalf("the cache did not expire (%d calls)", n)
	}
}

func TestReadyzLiveChecksAreNeverCached(t *testing.T) {
	draining := false
	h := NewHTTP("v1", ClientConfig{},
		CheckerFunc{N: "database", F: func(context.Context) error { return nil }},
		CheckerFunc{N: "shutdown", Live: true, F: func(context.Context) error {
			if draining {
				return errors.New("shutting down")
			}
			return nil
		}})
	if _, ok := mustReadyz(t, h, context.Background()).(api.Readyz200JSONResponse); !ok {
		t.Fatal("not ready")
	}
	draining = true
	if _, ok := mustReadyz(t, h, context.Background()).(api.Readyz503JSONResponse); !ok {
		t.Fatal("the drain did not turn readiness off at once")
	}
}

func TestReadyzDetailsOnlyForInternalCallers(t *testing.T) {
	h := NewHTTP("v1", ClientConfig{},
		CheckerFunc{N: "database", F: func(context.Context) error { return errors.New("dial tcp 10.1.2.3:5432: connection refused") }},
		CheckerFunc{N: "storage", F: func(context.Context) error { return nil }})
	public, ok := mustReadyz(t, h, context.Background()).(api.Readyz503JSONResponse)
	if !ok || public.Status != api.HealthStatusUnavailable || public.Checks != nil {
		t.Fatalf("public answer: %+v", public)
	}
	internal, ok := mustReadyz(t, h, WithDetails(context.Background())).(api.Readyz503JSONResponse)
	if !ok || internal.Checks == nil || (*internal.Checks)["storage"] != "ok" || (*internal.Checks)["database"] == "ok" {
		t.Fatalf("internal answer: %+v", internal)
	}
}

func mustReadyz(t *testing.T, h *HTTP, ctx context.Context) api.ReadyzResponseObject {
	t.Helper()
	res, err := h.Readyz(ctx, api.ReadyzRequestObject{})
	if err != nil {
		t.Fatal(err)
	}
	return res
}
