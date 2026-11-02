package transport

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// VaultEvent says "this vault reached this changelog position": pull now.
type VaultEvent struct {
	VaultID string
	Seq     int64
}

// ShareEvent says that a share was granted to the user, revoked or updated.
type ShareEvent struct {
	ShareID string
	Kind    string // granted | revoked | updated
}

// NotifyOptions configure the realtime channel (§3.4.4 D, §3.6).
type NotifyOptions struct {
	// GRPCEndpoint is host:port of NotifyService; "" disables gRPC (SSE only).
	GRPCEndpoint string
	DeviceID     string
	// Known returns the last seq the client holds per cloud vault id (replay).
	Known func() map[string]int64
	// Handler receives vault events; it must not block for long.
	Handler func(VaultEvent)
	// OnShare receives share events (invitations, revocations); may be nil.
	OnShare func(ShareEvent)
	// OnConfig receives the new configuration revision; may be nil.
	OnConfig func(version int)
	// ConfigVersion returns the revision the client holds (replayed when behind); may be nil.
	ConfigVersion func() int
	// OnState reports whether a stream is connected (the poller slows down while it is).
	OnState func(connected bool, via string)
	// Retry bounds the reconnect delay (default 60 s).
	MaxBackoff time.Duration
}

// RunNotifications keeps a notification stream open until ctx ends: gRPC
// first, SSE when gRPC cannot be used (corporate proxies), reconnecting with
// backoff and re-authenticating when the token expires. The WebAssembly core
// has no gRPC (notify_js.go) and uses SSE only.
//
// A token the server refuses is dropped (TokenInvalidator) so that the next
// attempt refreshes it. The first reconnection after a refusal is quick, as
// for a token that ran out during a long stream; refusals that follow one
// another back off, and after maxAuthRefusals of them the stream gives up and
// reports the session (SessionReporter) instead of knocking forever.
func (c *Client) RunNotifications(ctx context.Context, o NotifyOptions) {
	if o.MaxBackoff == 0 {
		o.MaxBackoff = 60 * time.Second
	}
	if o.OnState == nil {
		o.OnState = func(bool, string) {}
	}
	delay := retryBase
	grpcFailures, refusals := 0, 0
	for ctx.Err() == nil {
		var err error
		via := "grpc"
		connected, start := false, time.Now()
		so := o
		so.OnState = func(up bool, via string) {
			connected = connected || up
			o.OnState(up, via)
		}
		if grpcSupported && o.GRPCEndpoint != "" && grpcFailures < 2 {
			err = c.streamGRPC(ctx, so)
			if err != nil && !isAuthExpiry(err) {
				grpcFailures++
			}
		} else {
			via = "sse"
			err = c.streamSSE(ctx, so)
			// Retry gRPC now and then: the proxy may have been the problem only on that network.
			if grpcFailures >= 2 && o.GRPCEndpoint != "" && delay >= 30*time.Second {
				grpcFailures = 0
			}
		}
		o.OnState(false, via)
		if ctx.Err() != nil {
			return
		}
		if connected || time.Since(start) >= healthyStream {
			refusals = 0 // the token worked: whatever ends this stream starts a new count
		}
		if isAuthExpiry(err) {
			refusals++
			if refusals >= maxAuthRefusals {
				if r, ok := c.tokens.(SessionReporter); ok {
					r.SessionExpired(ErrSessionRejected)
				}
				return
			}
			// 1 s after a token that ran out (refreshed by Token), then doubling.
			delay = min(retryBase<<(refusals-1), o.MaxBackoff)
		} else {
			delay = min(delay*2, o.MaxBackoff)
		}
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

func isAuthExpiry(err error) bool {
	return isGRPCAuthExpiry(err) || errors.Is(err, errTokenExpired)
}

var errTokenExpired = errors.New("token expired")

// ErrSessionRejected is what RunNotifications reports (SessionReporter) when
// the server keeps refusing the session's tokens, new ones included: a
// revoked or deleted account, or a server that no longer trusts the identity
// provider. Signing in again is the way out.
var ErrSessionRejected = errors.New("the cloud keeps refusing the credentials of this session: sign in again")

const (
	// maxAuthRefusals is the number of refusals in a row after which the
	// notification stream gives up: about 30 s of backoff.
	maxAuthRefusals = 6
	// healthyStream is how long a stream must have lasted for its token to
	// count as accepted (a gRPC stream says nothing until the first event,
	// a refused token fails at once).
	healthyStream = 30 * time.Second
)

// retryBase is the first reconnection delay of RunNotifications (shorter in tests).
var retryBase = time.Second

func (c *Client) streamSSE(ctx context.Context, o NotifyOptions) error {
	q := url.Values{}
	if o.Known != nil {
		var parts []string
		for id, seq := range o.Known() {
			parts = append(parts, id+":"+strconv.FormatInt(seq, 10))
		}
		q.Set("known", strings.Join(parts, ","))
	}
	if o.ConfigVersion != nil {
		q.Set("config", strconv.Itoa(o.ConfigVersion()))
	}
	tok, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base.String()+BasePath+"/events?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "text/event-stream")
	// A stream has no overall deadline: use a client without the request timeout.
	hc := *c.http
	hc.Timeout = 0
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized {
		c.invalidateToken(tok)
		return errTokenExpired
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("events: HTTP %d", resp.StatusCode)
	}
	o.OnState(true, "sse")
	sc := bufio.NewScanner(resp.Body)
	var event string
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data := strings.TrimPrefix(line, "data: ")
			switch event {
			case "vault_changed":
				var ev struct {
					VaultID string `json:"vault_id"`
					Seq     int64  `json:"seq"`
				}
				if json.Unmarshal([]byte(data), &ev) == nil && o.Handler != nil {
					o.Handler(VaultEvent{VaultID: ev.VaultID, Seq: ev.Seq})
				}
			case "share_changed":
				var ev struct {
					ShareID string `json:"share_id"`
					Kind    string `json:"kind"`
				}
				if json.Unmarshal([]byte(data), &ev) == nil && o.OnShare != nil {
					o.OnShare(ShareEvent{ShareID: ev.ShareID, Kind: ev.Kind})
				}
			case "config_changed":
				var ev struct {
					Version int `json:"version"`
				}
				if json.Unmarshal([]byte(data), &ev) == nil && o.OnConfig != nil {
					o.OnConfig(ev.Version)
				}
			case "token-expired":
				c.invalidateToken(tok) // the server's clock decides, not ours
				return errTokenExpired
			}
		case line == "":
			event = ""
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return nil
}
