//go:build integration

package integration

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"clarae/services/cloud/internal/auth/authtest"
	"clarae/services/cloud/internal/grpcserver"
	"clarae/shared/notifyv1"
)

func TestHubCoalescesAndScopesEvents(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Events", "shared")
	h := ada.putBlob(v, []byte("x"))
	adaID, bobID := uuid.MustParse(ada.userID), uuid.MustParse(bob.userID)
	subAda, subBob := e.app.Hub.Subscribe(adaID), e.app.Hub.Subscribe(bobID)
	defer e.app.Hub.Unsubscribe(subAda)
	defer e.app.Hub.Unsubscribe(subBob)

	for i := 0; i < 3; i++ {
		mustAccepted(t, ada.commit(v, create(newID(), "n"+string(rune('a'+i))+".md", h))[0])
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Several commits may arrive as one coalesced event carrying the latest seq.
	var last int64
	for last < 3 {
		evs, err := subAda.Next(ctx)
		if err != nil {
			t.Fatalf("owner did not get the event: %v", err)
		}
		for _, ev := range evs {
			if ev.VaultID.String() != v {
				t.Fatalf("event for another vault: %v", ev)
			}
			last = max(last, ev.Seq)
		}
	}
	short, c2 := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer c2()
	if evs, err := subBob.Next(short); err == nil {
		t.Fatalf("another user received %v", evs)
	}
}

func TestSSEStream(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("SSE", "shared")
	h := ada.putBlob(v, []byte("x"))
	mustAccepted(t, ada.commit(v, create(newID(), "first.md", h))[0])

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.server.URL+"/api/v1/events?known="+v+":0", nil)
	req.Header.Set("Authorization", "Bearer "+ada.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status %d type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	lines := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	wait := func(substr string) string {
		t.Helper()
		for {
			select {
			case l, ok := <-lines:
				if !ok {
					t.Fatalf("stream closed while waiting for %q", substr)
				}
				if strings.Contains(l, substr) {
					return l
				}
			case <-ctx.Done():
				t.Fatalf("timeout waiting for %q", substr)
			}
		}
	}
	// Replay on connect: the vault is ahead of known=0.
	wait(`"seq":1`)
	// A live event.
	mustAccepted(t, ada.commit(v, create(newID(), "second.md", h))[0])
	wait(`"seq":2`)

	// No token, no stream.
	r2, _ := http.Get(e.server.URL + "/api/v1/events")
	if r2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated SSE: %d", r2.StatusCode)
	}
}

func TestGRPCSubscribe(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("GRPC", "shared")
	h := ada.putBlob(v, []byte("x"))

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpcserver.New(e.authn, e.app.Hub)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	cli := notifyv1.NewNotifyServiceClient(conn)

	// Without a token the stream is refused.
	noAuth, err := cli.Subscribe(context.Background(), &notifyv1.SubscribeRequest{})
	if err == nil {
		_, err = noAuth.Recv()
	}
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated subscribe: %v", err)
	}

	ctx, cancel := context.WithTimeout(metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer "+ada.token), 10*time.Second)
	defer cancel()
	mustAccepted(t, ada.commit(v, create(newID(), "one.md", h))[0])
	stream, err := cli.Subscribe(ctx, &notifyv1.SubscribeRequest{DeviceId: ada.deviceID, KnownSeq: map[string]int64{v: 0}})
	if err != nil {
		t.Fatal(err)
	}
	ev, err := stream.Recv()
	if err != nil || ev.GetVaultChanged().GetVaultId() != v || ev.GetVaultChanged().GetSeq() != 1 {
		t.Fatalf("replay event: %v %v", ev, err)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "two.md", h))[0])
	// The first commit's NOTIFY may still be in flight and show up as a duplicate of seq 1:
	// events only say "pull now", so repeats are harmless. Wait for the new position.
	for {
		ev, err = stream.Recv()
		if err != nil {
			t.Fatalf("live event: %v", err)
		}
		if ev.GetVaultChanged().GetSeq() >= 2 {
			break
		}
	}
}

func TestStreamEndsWhenTokenExpires(t *testing.T) {
	e := newEnv(t)
	short := e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-short", Username: "shorty", ExpiresIn: 2 * time.Second})
	// Provision the user through a normal call, then open the stream.
	if r := e.request(http.MethodGet, "/me", short, nil); r.StatusCode != http.StatusOK {
		t.Fatalf("me: %d", r.StatusCode)
	}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpcserver.New(e.authn, e.app.Hub)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	conn, _ := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	defer func() { _ = conn.Close() }()
	ctx, cancel := context.WithTimeout(metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer "+short), 15*time.Second)
	defer cancel()
	stream, err := notifyv1.NewNotifyServiceClient(conn).Subscribe(ctx, &notifyv1.SubscribeRequest{ConfigVersion: 1 << 30})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = stream.Recv()
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("stream ended with %v, want UNAUTHENTICATED", err)
	}
	if time.Since(start) > 6*time.Second {
		t.Fatalf("closed after %s, expected about 2 s", time.Since(start))
	}
}
