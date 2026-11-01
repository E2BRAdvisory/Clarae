//go:build js

package transport

import (
	"context"
	"errors"
)

// The browser has no raw TCP, so gRPC can never connect from the WebAssembly core: it is left out of
// this build (it is a large part of the binary, ADR-0020 WASM budget) and notifications use SSE only.
const grpcSupported = false

func isGRPCAuthExpiry(error) bool { return false }

func (c *Client) streamGRPC(context.Context, NotifyOptions) error {
	return errors.New("gRPC is not available in the browser")
}
