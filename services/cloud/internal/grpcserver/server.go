// Package grpcserver serves NotifyService (§3.6). Authentication reuses the
// HTTP token path; each stream is a subscriber of the notify hub and stays
// open until the client disconnects, the token expires, the account is
// suspended or the server shuts down.
package grpcserver

import (
	"context"
	"errors"
	"math"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/notify"
	"memobrain/shared/notifyv1"
)

// Hub is what the stream needs from the notify module.
type Hub interface {
	Open(user uuid.UUID) (*notify.Sub, error)
	Unsubscribe(s *notify.Sub)
	Replay(ctx context.Context, sub *notify.Sub, known map[string]int64, configVersion int64) error
}

// Connection lifetime. Keepalive pings find dead peers; MaxConnectionAge makes
// long-lived HTTP/2 connections reconnect now and then, which spreads them
// over the replicas after a scale-out and bounds how long a peer that stopped
// reading can hold a blocked Send (the grace period then closes it).
const (
	maxConnectionAge      = 30 * time.Minute
	maxConnectionAgeGrace = time.Minute
)

// Server is the gRPC server with a graceful shutdown that also ends the
// notification streams, which would otherwise keep GracefulStop waiting.
type Server struct {
	*grpc.Server
	done     chan struct{}
	stopOnce sync.Once
}

// Option configures New.
type Option func(*options)

type options struct{ log zerolog.Logger }

// WithLogger sets the logger of the panic recovery.
func WithLogger(l zerolog.Logger) Option { return func(o *options) { o.log = l } }

// New builds the gRPC server with the recovery and auth interceptors and NotifyService.
func New(authn *auth.Middleware, hub Hub, opts ...Option) *Server {
	o := options{log: zerolog.Nop()}
	for _, f := range opts {
		f(&o)
	}
	srv := &Server{done: make(chan struct{})}
	srv.Server = grpc.NewServer(
		// Recovery runs outermost, so a panic in authentication is caught too.
		grpc.ChainUnaryInterceptor(recoverUnary(o.log), unaryAuth(authn)),
		grpc.ChainStreamInterceptor(recoverStream(o.log), streamAuth(authn)),
		grpc.KeepaliveParams(keepalive.ServerParameters{
			Time: 30 * time.Second, Timeout: 10 * time.Second,
			MaxConnectionAge: maxConnectionAge, MaxConnectionAgeGrace: maxConnectionAgeGrace,
		}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{MinTime: 10 * time.Second, PermitWithoutStream: true}),
	)
	notifyv1.RegisterNotifyServiceServer(srv.Server, &notifyServer{hub: hub, done: srv.done})
	return srv
}

// Shutdown ends every notification stream (clients reconnect elsewhere and
// replay from their known positions), waits up to timeout for the server to
// stop gracefully, and then stops it hard.
func (s *Server) Shutdown(timeout time.Duration) {
	s.stopOnce.Do(func() { close(s.done) })
	finished := make(chan struct{})
	go func() { s.GracefulStop(); close(finished) }()
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-finished:
	case <-t.C:
		s.Stop()
		<-finished
	}
}

type notifyServer struct {
	notifyv1.UnimplementedNotifyServiceServer
	hub  Hub
	done <-chan struct{} // closed when the server shuts down; nil never closes
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
	if exp := auth.TokenExpiryFrom(ctx); !exp.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, exp)
		defer cancel()
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	shutdown := make(chan struct{})
	go func() {
		select {
		case <-n.done:
			close(shutdown)
			cancel()
		case <-ctx.Done():
		}
	}()
	sub, err := n.hub.Open(p.UserID)
	if err != nil {
		return status.Error(codes.ResourceExhausted, err.Error())
	}
	defer n.hub.Unsubscribe(sub)
	if err := n.hub.Replay(ctx, sub, req.GetKnownSeq(), int64(req.GetConfigVersion())); err != nil {
		return status.Error(codes.Internal, "replay failed")
	}
	for {
		batch, err := sub.Next(ctx)
		if err != nil {
			select {
			case <-shutdown:
				return status.Error(codes.Unavailable, "server shutting down")
			default:
			}
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
			case notify.KindAccount:
				msg = &notifyv1.Event{Payload: &notifyv1.Event_AccountChanged{AccountChanged: &notifyv1.AccountChanged{Kind: ev.AccountKind}}}
			case notify.KindConfig:
				msg = &notifyv1.Event{Payload: &notifyv1.Event_ConfigChanged{ConfigChanged: &notifyv1.ConfigChanged{Version: clampInt32(ev.Revision)}}}
			default:
				msg = &notifyv1.Event{Payload: &notifyv1.Event_VaultChanged{VaultChanged: &notifyv1.VaultChanged{VaultId: ev.VaultID.String(), Seq: ev.Seq}}}
			}
			if err := stream.Send(msg); err != nil {
				return err
			}
			if notify.EndsStream(ev) {
				return status.Error(codes.PermissionDenied, "account suspended")
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
	case errors.Is(err, auth.ErrIdentityConflict):
		return nil, status.Error(codes.FailedPrecondition, auth.IdentityConflictDetail)
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

// recoverUnary turns a panic of a unary handler (or of the interceptors after
// it) into INTERNAL instead of crashing the process: grpc-go does not recover.
func recoverUnary(log zerolog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error().Interface("panic", r).Str("method", info.FullMethod).Bytes("stack", debug.Stack()).Msg("grpc handler panicked")
				resp, err = nil, status.Error(codes.Internal, "internal error")
			}
		}()
		return handler(ctx, req)
	}
}

// recoverStream is recoverUnary for streaming handlers.
func recoverStream(log zerolog.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error().Interface("panic", r).Str("method", info.FullMethod).Bytes("stack", debug.Stack()).Msg("grpc stream panicked")
				err = status.Error(codes.Internal, "internal error")
			}
		}()
		return handler(srv, ss)
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
