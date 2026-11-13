package grpcserver

import (
	"context"
	"net"
	"sync"
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

	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/auth/authtest"
	"clarae/services/cloud/internal/notify"
	"clarae/shared/notifyv1"
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

func newHarness(t *testing.T, prov auth.Provisioner, replay []notify.Event, maxStreams int, opts ...Option) *harness {
	t.Helper()
	iss := authtest.New(t)
	v, err := auth.NewVerifier(context.Background(), iss.URL(), "clarae-api", nil)
	if err != nil {
		t.Fatal(err)
	}
	hub := notify.NewHub(nil, zerolog.Nop())
	hub.MaxStreamsPerUser = maxStreams
	srv := New(auth.NewMiddleware(v, prov, nil, time.Minute), fakeHub{hub: hub, replay: replay}, opts...)
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

// bucketLimiter allows burst calls per key, then refuses.
type bucketLimiter struct {
	mu    sync.Mutex
	burst int
	used  map[string]int
}

func newBucketLimiter(burst int) *bucketLimiter {
	return &bucketLimiter{burst: burst, used: map[string]int{}}
}

func (l *bucketLimiter) Take(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.used[key] >= l.burst {
		return false, 1500 * time.Millisecond
	}
	l.used[key]++
	return true, 0
}

func (l *bucketLimiter) keys() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for k := range l.used {
		out = append(out, k)
	}
	return out
}

// recordingClientIP resolves every caller to a fixed address and records its input.
type recordingClientIP struct {
	mu        sync.Mutex
	forwarded []string
}

func (c *recordingClientIP) OfPeer(_ string, forwardedFor []string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.forwarded = forwardedFor
	return "198.51.100.9"
}

// Regression (M12): the notification streams had no rate limit, and every
// Subscribe replays the caller's positions from the database.
func TestSubscribeIsLimitedPerUser(t *testing.T) {
	ada, bob := uuid.New(), uuid.New()
	perUser := newBucketLimiter(2)
	h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": ada, "bob": bob}}, []notify.Event{{VaultID: uuid.New(), Seq: 1}}, 0,
		WithRateLimits(RateLimits{PerUser: perUser}))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := range 2 {
		if _, err := h.subscribe(t, ctx, "ada").Recv(); err != nil {
			t.Fatalf("subscribe %d within the budget: %v", i, err)
		}
	}
	stream := h.subscribe(t, ctx, "ada")
	_, err := stream.Recv()
	if status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("third subscribe: %v, want RESOURCE_EXHAUSTED", err)
	}
	if got := stream.Trailer().Get("retry-after"); len(got) != 1 || got[0] != "2" {
		t.Fatalf("retry-after trailer %v, want [2]", got)
	}
	if _, err := h.subscribe(t, ctx, "bob").Recv(); err != nil {
		t.Fatalf("another user is limited too: %v", err)
	}
}

// The per-IP limit runs before authentication: a flood of forged tokens is
// refused without verifying them.
func TestSubscribeIsLimitedPerIPBeforeAuthentication(t *testing.T) {
	perIP := newBucketLimiter(1)
	ip := &recordingClientIP{}
	h := newHarness(t, provisioner{}, nil, 0, WithRateLimits(RateLimits{PerIP: perIP, ClientIP: ip}))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func() error {
		md := metadata.Pairs("authorization", "Bearer forged.token.value", "x-forwarded-for", "203.0.113.7")
		stream, err := h.cli.Subscribe(metadata.NewOutgoingContext(ctx, md), &notifyv1.SubscribeRequest{})
		if err == nil {
			_, err = stream.Recv()
		}
		return err
	}
	if err := call(); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("first call: %v, want UNAUTHENTICATED", err)
	}
	if err := call(); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("second call: %v, want RESOURCE_EXHAUSTED before the token is looked at", err)
	}
	if keys := perIP.keys(); len(keys) != 1 || keys[0] != "ip:198.51.100.9" {
		t.Fatalf("limiter keys %v, want the resolved client", keys)
	}
	ip.mu.Lock()
	defer ip.mu.Unlock()
	if len(ip.forwarded) != 1 || ip.forwarded[0] != "203.0.113.7" {
		t.Fatalf("x-forwarded-for passed to the resolver: %v", ip.forwarded)
	}
}

func TestOversizedSubscribeRequestIsRefused(t *testing.T) {
	h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": uuid.New()}}, nil, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	known := map[string]int64{}
	for range maxRecvMsgSize / 40 {
		known[uuid.NewString()] = 1
	}
	tok := h.issuer.Token(t, authtest.TokenOptions{Subject: "ada"})
	stream, err := h.cli.Subscribe(metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+tok), &notifyv1.SubscribeRequest{KnownSeq: known})
	if err == nil {
		_, err = stream.Recv()
	}
	if status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("oversized request: %v, want RESOURCE_EXHAUSTED", err)
	}
}
