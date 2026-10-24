package system

import (
	"context"
	"testing"

	"nodus/services/cloud/internal/api"
)

func TestClientConfigExposesBothClientIDs(t *testing.T) {
	h := NewHTTP("v1", ClientConfig{
		Issuer: "https://id.example.com/realms/nodus", DesktopClientID: "nodus-desktop", WebClientID: "nodus-web",
		Audience: "nodus-api", GRPCEndpoint: "host:18082",
	})
	res, err := h.GetClientConfig(context.Background(), api.GetClientConfigRequestObject{})
	if err != nil {
		t.Fatal(err)
	}
	cc, ok := res.(api.GetClientConfig200JSONResponse)
	if !ok {
		t.Fatalf("unexpected response %T", res)
	}
	if cc.WebClientId != "nodus-web" || cc.DesktopClientId != "nodus-desktop" || cc.Issuer == "" || cc.ApiVersion != "v1" {
		t.Fatalf("client config: %+v", cc)
	}
}
