//go:build js

package transport

import "github.com/coder/websocket"

// presenceDialOptions: in the browser the WebSocket is the page's own, which takes no HTTP client and
// sets no header; the token goes in the first frame.
func (c *Client) presenceDialOptions() *websocket.DialOptions { return &websocket.DialOptions{} }
