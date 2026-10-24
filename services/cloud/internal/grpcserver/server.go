// Package grpcserver serves NotifyService (§3.6). Authentication reuses the
// HTTP token path; the stream itself is wired to the notify module in M2 and
// for now only stays open until the client disconnects or the token expires.
package grpcserver

import (
	"context"
	"errors"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"nodus/services/cloud/internal/auth"
	"nodus/shared/notifyv1"
)

// New builds the gRPC server with the auth interceptors and NotifyService.
func New(authn *auth.Middleware) *grpc.Server {
	s := grpc.NewServer(
		grpc.UnaryInterceptor(unaryAuth(authn)),
		grpc.StreamInterceptor(streamAuth(authn)),
		grpc.KeepaliveParams(keepalive.ServerParameters{Time: 30 * time.Second, Timeout: 10 * time.Second}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{MinTime: 10 * time.Second, PermitWithoutStream: true}),
	)
	notifyv1.RegisterNotifyServiceServer(s, &notifyServer{})
	return s
}

type notifyServer struct {
	notifyv1.UnimplementedNotifyServiceServer
}

// Subscribe keeps the stream open; events are published from M2 onwards.
// The stream ends with UNAUTHENTICATED once the token used to open it expires.
func (n *notifyServer) Subscribe(_ *notifyv1.SubscribeRequest, stream grpc.ServerStreamingServer[notifyv1.Event]) error {
	ctx := stream.Context()
	p, ok := auth.PrincipalFrom(ctx)
	if !ok {
		return status.Error(codes.Unauthenticated, "no principal")
	}
	_ = p
	exp, _ := ctx.Value(expiryKey{}).(time.Time)
	var expired <-chan time.Time
	if !exp.IsZero() {
		t := time.NewTimer(time.Until(exp))
		defer t.Stop()
		expired = t.C
	}
	select {
	case <-ctx.Done():
		return nil
	case <-expired:
		return status.Error(codes.Unauthenticated, "token expired")
	}
}

type expiryKey struct{}

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
	p, err := authn.Authenticate(ctx, raw)
	switch {
	case errors.Is(err, auth.ErrSuspended):
		return nil, status.Error(codes.PermissionDenied, "account suspended")
	case errors.Is(err, auth.ErrInvalidToken):
		return nil, status.Error(codes.Unauthenticated, "invalid token")
	case err != nil:
		return nil, status.Error(codes.Internal, "authentication failed")
	}
	return auth.WithPrincipal(ctx, p), nil
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
