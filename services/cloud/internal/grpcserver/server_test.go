package grpcserver

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/notify"
	"memobrain/shared/notifyv1"
)

// fakeHub serves subscriptions from a real (database-less) hub and replays a
// fixed snapshot.
type fakeHub struct {
	hub    *notify.Hub
	replay []notify.Event
}

func (f fakeHub) Subscribe(user uuid.UUID) *notify.Sub { return f.hub.Subscribe(user) }
func (f fakeHub) Unsubscribe(s *notify.Sub)            { f.hub.Unsubscribe(s) }
func (f fakeHub) Snapshot(context.Context, uuid.UUID, map[string]int64, int64) ([]notify.Event, error) {
	return f.replay, nil
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
