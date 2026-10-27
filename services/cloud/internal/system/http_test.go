package system

import (
	"context"
	"testing"

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
