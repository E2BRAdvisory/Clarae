// Package grpcserver serves NotifyService (§3.6). Authentication reuses the
// HTTP token path; the stream itself is wired to the notify module in M2 and
// for now only stays open until the client disconnects or the token expires.
package grpcserver

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"nodus/services/cloud/internal/auth"
	"nodus/services/cloud/internal/notify"
	"nodus/shared/notifyv1"
)

// Hub is what the stream needs from the notify module.
type Hub interface {
	Subscribe(user uuid.UUID) *notify.Sub
	Unsubscribe(s *notify.Sub)
	Snapshot(ctx context.Context, user uuid.UUID, known map[string]int64, configVersion int64) ([]notify.Event, error)
}

// New builds the gRPC server with the auth interceptors and NotifyService.
func New(authn *auth.Middleware, hub Hub) *grpc.Server {
	s := grpc.NewServer(
		grpc.UnaryInterceptor(unaryAuth(authn)),
		grpc.StreamInterceptor(streamAuth(authn)),
		grpc.KeepaliveParams(keepalive.ServerParameters{Time: 30 * time.Second, Timeout: 10 * time.Second}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{MinTime: 10 * time.Second, PermitWithoutStream: true}),
	)
	notifyv1.RegisterNotifyServiceServer(s, &notifyServer{hub: hub})
	return s
}

type notifyServer struct {
	notifyv1.UnimplementedNotifyServiceServer
	hub Hub
}

// Subscribe streams "vault X reached seq N" events for the caller's vaults,
// first replaying every vault that is ahead of the client's known_seq. The
// stream ends with UNAUTHENTICATED once the token used to open it expires.
func (n *notifyServer) Subscribe(req *notifyv1.SubscribeRequest, stream grpc.ServerStreamingServer[notifyv1.Event]) error {
	ctx := stream.Context()
	p, ok := auth.PrincipalFrom(ctx)
	if !ok {
		return status.Error(codes.Unauthenticated, "no principal")
	}
	expired := false
	if exp := auth.TokenExpiryFrom(ctx); !exp.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, exp)
		defer cancel()
		defer func() { _ = expired }()
	}
	sub := n.hub.Subscribe(p.UserID)
	defer n.hub.Unsubscribe(sub)
	replay, err := n.hub.Snapshot(ctx, p.UserID, req.GetKnownSeq(), int64(req.GetConfigVersion()))
	if err != nil {
		return status.Error(codes.Internal, "replay failed")
	}
	for _, ev := range replay {
		sub.Push(ev)
	}
	for {
		batch, err := sub.Next(ctx)
		if err != nil {
			if stream.Context().Err() != nil {
				return nil // the client went away
			}
			return status.Error(codes.Unauthenticated, "token expired")
		}
		for _, ev := range batch {
			var msg *notifyv1.Event
			switch ev.Kind {
			case notify.KindShare:
				msg = &notifyv1.Event{Payload: &notifyv1.Event_ShareChanged{ShareChanged: &notifyv1.ShareChanged{ShareId: ev.ShareID.String(), Kind: ev.ShareKind}}}
			case notify.KindConfig:
				msg = &notifyv1.Event{Payload: &notifyv1.Event_ConfigChanged{ConfigChanged: &notifyv1.ConfigChanged{Version: clampInt32(ev.Revision)}}}
			default:
				msg = &notifyv1.Event{Payload: &notifyv1.Event_VaultChanged{VaultChanged: &notifyv1.VaultChanged{VaultId: ev.VaultID.String(), Seq: ev.Seq}}}
			}
			if err := stream.Send(msg); err != nil {
				return err
			}
		}
	}
}

func authenticate(ctx context.Context, authn *auth.Middleware) (context.Context, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	var raw string
	for _, v := range md.Get("authorization") {
		if len(v) > 7 && strings.EqualFold(v[:7], "Bearer ") {
			raw = strings.TrimSpace(v[7:])
		}
	}
	if raw == "" {
		return nil, status.Error(codes.Unauthenticated, "missing bearer token")
	}
	p, exp, err := authn.AuthenticateExp(ctx, raw)
	switch {
	case errors.Is(err, auth.ErrSuspended):
		return nil, status.Error(codes.PermissionDenied, "account suspended")
	case errors.Is(err, auth.ErrInvalidToken):
		return nil, status.Error(codes.Unauthenticated, "invalid token")
	case err != nil:
		return nil, status.Error(codes.Internal, "authentication failed")
	}
	return auth.WithTokenExpiry(auth.WithPrincipal(ctx, p), exp), nil
}

func unaryAuth(authn *auth.Middleware) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		ctx, err := authenticate(ctx, authn)
		if err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

func streamAuth(authn *auth.Middleware) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, _ *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		ctx, err := authenticate(ss.Context(), authn)
		if err != nil {
			return err
		}
		return handler(srv, &wrappedStream{ServerStream: ss, ctx: ctx})
	}
}

type wrappedStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *wrappedStream) Context() context.Context { return w.ctx }

func clampInt32(n int64) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	if n < 0 {
		return 0
	}
	return int32(n)
}
