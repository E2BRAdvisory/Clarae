//go:build !js

package transport

import (
	"context"
	"crypto/tls"
	"math"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"memobrain/shared/notifyv1"
)

// grpcSupported: the native builds open the gRPC stream first (§3.4.4 D). The WebAssembly core cannot
// (no raw TCP in a browser), so it is built without gRPC and uses SSE only (notify_js.go).
const grpcSupported = true

func isGRPCAuthExpiry(err error) bool { return status.Code(err) == codes.Unauthenticated }

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

func clampInt32(n int) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	if n < 0 {
		return 0
	}
	return int32(n)
}
