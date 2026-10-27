package transport

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"memobrain/shared/notifyv1"
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
// backoff and re-authenticating when the token expires.
func (c *Client) RunNotifications(ctx context.Context, o NotifyOptions) {
	if o.MaxBackoff == 0 {
		o.MaxBackoff = 60 * time.Second
	}
	if o.OnState == nil {
		o.OnState = func(bool, string) {}
	}
	delay := time.Second
	grpcFailures := 0
	for ctx.Err() == nil {
		var err error
		via := "grpc"
		if o.GRPCEndpoint != "" && grpcFailures < 2 {
			err = c.streamGRPC(ctx, o)
			if err != nil && !isAuthExpiry(err) {
				grpcFailures++
			}
		} else {
			via = "sse"
			err = c.streamSSE(ctx, o)
			// Retry gRPC now and then: the proxy may have been the problem only on that network.
			if grpcFailures >= 2 && o.GRPCEndpoint != "" && delay >= 30*time.Second {
				grpcFailures = 0
			}
		}
		o.OnState(false, via)
		if ctx.Err() != nil {
			return
		}
		if isAuthExpiry(err) {
			delay = time.Second // the token ran out: refresh (done by Token) and reconnect at once
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
	if status.Code(err) == codes.Unauthenticated {
		return true
	}
	return errors.Is(err, errTokenExpired)
}

var errTokenExpired = errors.New("token expired")

func (c *Client) streamGRPC(ctx context.Context, o NotifyOptions) error {
	var creds credentials.TransportCredentials
	if c.base.Scheme == "https" {
		creds = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})
	} else {
		creds = insecure.NewCredentials()
	}
	conn, err := grpc.NewClient(o.GRPCEndpoint, grpc.WithTransportCredentials(creds))
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	tok, err := c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	sctx, cancel := context.WithCancel(metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+tok))
	defer cancel()
	known := map[string]int64{}
	if o.Known != nil {
		known = o.Known()
	}
	req := &notifyv1.SubscribeRequest{DeviceId: o.DeviceID, KnownSeq: known}
	if o.ConfigVersion != nil {
		req.ConfigVersion = clampInt32(o.ConfigVersion())
	}
	stream, err := notifyv1.NewNotifyServiceClient(conn).Subscribe(sctx, req)
	if err != nil {
		return err
	}
	first := true
	for {
		ev, err := stream.Recv()
		if err != nil {
			return err
		}
		if first {
			first = false
			o.OnState(true, "grpc")
		}
		if vc := ev.GetVaultChanged(); vc != nil && o.Handler != nil {
			o.Handler(VaultEvent{VaultID: vc.GetVaultId(), Seq: vc.GetSeq()})
		}
		if sc := ev.GetShareChanged(); sc != nil && o.OnShare != nil {
			o.OnShare(ShareEvent{ShareID: sc.GetShareId(), Kind: sc.GetKind()})
		}
		if cc := ev.GetConfigChanged(); cc != nil && o.OnConfig != nil {
			o.OnConfig(int(cc.GetVersion()))
		}
	}
}

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

func clampInt32(n int) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	if n < 0 {
		return 0
	}
	return int32(n)
}
