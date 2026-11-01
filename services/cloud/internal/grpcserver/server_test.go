package grpcserver

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/auth/authtest"
	"memobrain/services/cloud/internal/notify"
	"memobrain/shared/notifyv1"
)

// fakeHub serves subscriptions from a real (database-less) hub and replays a
// fixed snapshot.
type fakeHub struct {
	hub    *notify.Hub
	replay []notify.Event
}

func (f fakeHub) Open(user uuid.UUID) (*notify.Sub, error) { return f.hub.Open(user) }
func (f fakeHub) Unsubscribe(s *notify.Sub)                { f.hub.Unsubscribe(s) }
func (f fakeHub) Replay(_ context.Context, sub *notify.Sub, _ map[string]int64, _ int64) error {
	for _, ev := range f.replay {
		sub.Push(ev)
	}
	return nil
}

type recordingStream struct {
	grpc.ServerStream
	ctx  context.Context
	sent []*notifyv1.Event
}

func (s *recordingStream) Context() context.Context { return s.ctx }
func (s *recordingStream) Send(e *notifyv1.Event) error {
	s.sent = append(s.sent, e)
	return nil
}

func TestSubscribeEndsAfterSuspension(t *testing.T) {
	v := uuid.New()
	hub := fakeHub{hub: notify.NewHub(nil, zerolog.Nop()), replay: []notify.Event{
		{VaultID: v, Seq: 3},
		{Kind: notify.KindAccount, AccountKind: notify.AccountSuspended},
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream := &recordingStream{ctx: auth.WithPrincipal(ctx, auth.Principal{UserID: uuid.New()})}
	err := (&notifyServer{hub: hub}).Subscribe(&notifyv1.SubscribeRequest{}, stream)
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("stream ended with %v, want PERMISSION_DENIED", err)
	}
	if ctx.Err() != nil {
		t.Fatal("the stream must end on the suspension, not on the deadline")
	}
	var account *notifyv1.AccountChanged
	for _, e := range stream.sent {
		if a := e.GetAccountChanged(); a != nil {
			account = a
		}
	}
	if account == nil || account.GetKind() != notify.AccountSuspended {
		t.Fatalf("the suspension event must be delivered before closing: %v", stream.sent)
	}
}

// provisioner resolves every subject to a fixed outcome.
type provisioner struct {
	users map[string]uuid.UUID
	err   error
}

func (p provisioner) Provision(_ context.Context, c auth.Claims) (auth.Principal, error) {
	if p.err != nil {
		return auth.Principal{}, p.err
	}
	return auth.Principal{UserID: p.users[c.Subject], Subject: c.Subject, Role: auth.RoleUser, Status: auth.StatusActive}, nil
}

// harness runs the real server (interceptors included) over an in-memory
// connection.
type harness struct {
	srv    *Server
	hub    *notify.Hub
	issuer *authtest.Issuer
	cli    notifyv1.NotifyServiceClient
}

func newHarness(t *testing.T, prov auth.Provisioner, replay []notify.Event, maxStreams int) *harness {
	t.Helper()
	iss := authtest.New(t)
	v, err := auth.NewVerifier(context.Background(), iss.URL(), "memobrain-api", nil)
	if err != nil {
		t.Fatal(err)
	}
	hub := notify.NewHub(nil, zerolog.Nop())
	hub.MaxStreamsPerUser = maxStreams
	srv := New(auth.NewMiddleware(v, prov, nil, time.Minute), fakeHub{hub: hub, replay: replay})
	lis := bufconn.Listen(1 << 20)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &harness{srv: srv, hub: hub, issuer: iss, cli: notifyv1.NewNotifyServiceClient(conn)}
}

func (h *harness) subscribe(t *testing.T, ctx context.Context, subject string) notifyv1.NotifyService_SubscribeClient {
	t.Helper()
	tok := h.issuer.Token(t, authtest.TokenOptions{Subject: subject})
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+tok)
	stream, err := h.cli.Subscribe(ctx, &notifyv1.SubscribeRequest{})
	if err != nil {
		t.Fatal(err)
	}
	return stream
}

func TestStreamReceivesReplayAndHubEvents(t *testing.T) {
	user, v := uuid.New(), uuid.New()
	h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": user}}, []notify.Event{{VaultID: v, Seq: 7}}, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream := h.subscribe(t, ctx, "ada")
	ev, err := stream.Recv()
	if err != nil || ev.GetVaultChanged().GetSeq() != 7 || ev.GetVaultChanged().GetVaultId() != v.String() {
		t.Fatalf("replay: %v %v", ev, err)
	}
	h.hub.DispatchConfig(12)
	if ev, err = stream.Recv(); err != nil || ev.GetConfigChanged().GetVersion() != 12 {
		t.Fatalf("live event: %v %v", ev, err)
	}
}

func TestAuthenticationErrorsMapToStatusCodes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for name, c := range map[string]struct {
		err  error
		want codes.Code
	}{
		"suspended":         {auth.ErrSuspended, codes.PermissionDenied},
		"identity conflict": {auth.ErrIdentityConflict, codes.FailedPrecondition},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, provisioner{err: c.err}, nil, 0)
			_, err := h.subscribe(t, ctx, "ada").Recv()
			if status.Code(err) != c.want {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
	t.Run("missing token", func(t *testing.T) {
		h := newHarness(t, provisioner{}, nil, 0)
		stream, err := h.cli.Subscribe(ctx, &notifyv1.SubscribeRequest{})
		if err == nil {
			_, err = stream.Recv()
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("got %v, want UNAUTHENTICATED", err)
		}
	})
}

func TestStreamsPerUserAreCapped(t *testing.T) {
	ada, bob := uuid.New(), uuid.New()
	h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": ada, "bob": bob}}, []notify.Event{{VaultID: uuid.New(), Seq: 1}}, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first := h.subscribe(t, ctx, "ada")
	if _, err := first.Recv(); err != nil {
		t.Fatal(err)
	}
	if _, err := h.subscribe(t, ctx, "ada").Recv(); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("second stream of the same user: %v, want RESOURCE_EXHAUSTED", err)
	}
	// Another user is not affected.
	if _, err := h.subscribe(t, ctx, "bob").Recv(); err != nil {
		t.Fatalf("stream of another user: %v", err)
	}
}

// Regression (W8): GracefulStop waited for every open Subscribe stream until
// the shutdown timeout. Shutdown ends the streams first.
func TestShutdownEndsOpenStreams(t *testing.T) {
	user := uuid.New()
	h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": user}}, []notify.Event{{VaultID: uuid.New(), Seq: 1}}, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream := h.subscribe(t, ctx, "ada")
	if _, err := stream.Recv(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	done := make(chan struct{})
	go func() { h.srv.Shutdown(8 * time.Second); close(done) }()
	_, err := stream.Recv()
	if status.Code(err) != codes.Unavailable {
		t.Fatalf("stream ended with %v, want UNAVAILABLE", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown kept waiting for the stream")
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("Shutdown took %s", took)
	}
}

func TestRecoveryInterceptorsTurnPanicsIntoInternal(t *testing.T) {
	_, err := recoverUnary(zerolog.Nop())(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/x/Y"},
		func(context.Context, any) (any, error) { panic("boom") })
	if status.Code(err) != codes.Internal {
		t.Fatalf("unary: %v", err)
	}
	err = recoverStream(zerolog.Nop())(nil, &recordingStream{ctx: context.Background()}, &grpc.StreamServerInfo{FullMethod: "/x/Z"},
		func(any, grpc.ServerStream) error { panic("boom") })
	if status.Code(err) != codes.Internal {
		t.Fatalf("stream: %v", err)
	}
	if err := recoverStream(zerolog.Nop())(nil, &recordingStream{ctx: context.Background()}, &grpc.StreamServerInfo{},
		func(any, grpc.ServerStream) error { return status.Error(codes.NotFound, "x") }); status.Code(err) != codes.NotFound {
		t.Fatalf("errors pass through: %v", err)
	}
}
