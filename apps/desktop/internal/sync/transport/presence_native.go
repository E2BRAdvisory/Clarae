//go:build !js

package transport

import (
	"net/http"

	"github.com/coder/websocket"
)

// presenceDialOptions: the client of the API without its request timeout (a stream has no overall
// deadline), so proxies and certificates are the same as for the rest of the traffic.
func (c *Client) presenceDialOptions() *websocket.DialOptions {
	hc := *c.http
	hc.Timeout = 0
	return &websocket.DialOptions{HTTPClient: &hc, HTTPHeader: http.Header{"User-Agent": []string{c.userAgent}}}
}
