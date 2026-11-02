//go:build !js

package transport

import (
	"context"
	"errors"
	"testing"
)

// The desktop refuses to talk to a server in clear unless it runs on this
// computer (the browser core is exempt: the page decides).
func TestNewRefusesPlainHTTPToAnotherComputer(t *testing.T) {
	for _, u := range []string{"http://cloud.example.com", "http://localhost@cloud.example.com", "http://10.1.2.3:8080"} {
		if _, err := New(u, nil, nil, "test"); !errors.Is(err, ErrInsecureURL) {
			t.Errorf("%s: %v", u, err)
		}
	}
	for _, u := range []string{"https://cloud.example.com", "http://localhost:18081", "http://127.0.0.1:1", "http://[::1]:8080"} {
		if _, err := New(u, nil, nil, "test"); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
}

// A server reached in clear on this computer cannot send the bearer token in
// clear to a gRPC endpoint elsewhere.
func TestPlainGRPCOnlyToThisComputer(t *testing.T) {
	c, err := New("http://127.0.0.1:1", staticTokens("tok"), nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	for _, ep := range []string{"notify.example.com:443", "localhost.example.com:1", "no-port"} {
		if err := c.streamGRPC(context.Background(), NotifyOptions{GRPCEndpoint: ep}); !errors.Is(err, ErrInsecureURL) {
			t.Errorf("%s: %v", ep, err)
		}
	}
}
