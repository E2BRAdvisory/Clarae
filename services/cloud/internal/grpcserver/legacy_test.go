package grpcserver

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/reflect/protoreflect"

	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/auth/authtest"
	"clarae/services/cloud/internal/notify"
	"clarae/shared/notifyv1"
	"clarae/shared/notifyv1legacy"
)

func (h *harness) legacySubscribe(t *testing.T, ctx context.Context) notifyv1legacy.NotifyService_SubscribeClient {
	t.Helper()
	tok := h.issuer.Token(t, authtest.TokenOptions{Subject: "ada"})
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+tok)
	stream, err := notifyv1legacy.NewNotifyServiceClient(h.conn).Subscribe(ctx, &notifyv1legacy.SubscribeRequest{})
	if err != nil {
		t.Fatal(err)
	}
	return stream
}

// A client 1.4.0 calls /memobrain.v1.NotifyService/Subscribe: it must get the same stream as a new
// client gets on /clarae.v1.NotifyService/Subscribe (the same handler), not UNIMPLEMENTED.
func TestLegacyServiceStreamsEveryKindOfEvent(t *testing.T) {
	user, v, share := uuid.New(), uuid.New(), uuid.New()
	replay := []notify.Event{
		{VaultID: v, Seq: 7},
		{Kind: notify.KindShare, ShareID: share, ShareKind: notify.ShareGranted},
		{Kind: notify.KindConfig, Revision: 4},
	}
	h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": user}}, replay, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	info := h.srv.GetServiceInfo()
	for _, name := range []string{"clarae.v1.NotifyService", "memobrain.v1.NotifyService"} {
		if _, ok := info[name]; !ok {
			t.Fatalf("service %s is not registered: %v", name, info)
		}
	}

	stream := h.legacySubscribe(t, ctx)
	ev, err := stream.Recv()
	if err != nil || ev.GetVaultChanged().GetSeq() != 7 || ev.GetVaultChanged().GetVaultId() != v.String() {
		t.Fatalf("replayed vault event: %v %v", ev, err)
	}
	if ev, err = stream.Recv(); err != nil || ev.GetShareChanged().GetShareId() != share.String() || ev.GetShareChanged().GetKind() != notify.ShareGranted {
		t.Fatalf("replayed share event: %v %v", ev, err)
	}
	if ev, err = stream.Recv(); err != nil || ev.GetConfigChanged().GetVersion() != 4 {
		t.Fatalf("replayed config event: %v %v", ev, err)
	}
	// Live events reach it too, in the legacy message type.
	h.hub.DispatchConfig(12)
	if ev, err = stream.Recv(); err != nil || ev.GetConfigChanged().GetVersion() != 12 {
		t.Fatalf("live event: %v %v", ev, err)
	}
}

// The adapter adds no logic: authentication, the suspension that ends a stream and the
// per-user cap are the ones of the new service.
func TestLegacyServiceSharesAuthenticationAndLimits(t *testing.T) {
	ada := uuid.New()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("a token is required", func(t *testing.T) {
		h := newHarness(t, provisioner{}, nil, 0)
		stream, err := notifyv1legacy.NewNotifyServiceClient(h.conn).Subscribe(ctx, &notifyv1legacy.SubscribeRequest{})
		if err == nil {
			_, err = stream.Recv()
		}
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("got %v, want UNAUTHENTICATED", err)
		}
	})

	t.Run("a suspended account is refused", func(t *testing.T) {
		h := newHarness(t, provisioner{err: auth.ErrSuspended}, nil, 0)
		if _, err := h.legacySubscribe(t, ctx).Recv(); status.Code(err) != codes.PermissionDenied {
			t.Fatalf("got %v, want PERMISSION_DENIED", err)
		}
	})

	t.Run("the suspension ends the stream after it is delivered", func(t *testing.T) {
		replay := []notify.Event{{Kind: notify.KindAccount, AccountKind: notify.AccountSuspended}}
		h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": ada}}, replay, 0)
		stream := h.legacySubscribe(t, ctx)
		ev, err := stream.Recv()
		if err != nil || ev.GetAccountChanged().GetKind() != notify.AccountSuspended {
			t.Fatalf("suspension event: %v %v", ev, err)
		}
		if _, err = stream.Recv(); status.Code(err) != codes.PermissionDenied {
			t.Fatalf("stream ended with %v, want PERMISSION_DENIED", err)
		}
	})

	t.Run("one budget of streams per user across both services", func(t *testing.T) {
		replay := []notify.Event{{VaultID: uuid.New(), Seq: 1}}
		h := newHarness(t, provisioner{users: map[string]uuid.UUID{"ada": ada}}, replay, 1)
		first := h.subscribe(t, ctx, "ada") // new service
		if _, err := first.Recv(); err != nil {
			t.Fatal(err)
		}
		if _, err := h.legacySubscribe(t, ctx).Recv(); status.Code(err) != codes.ResourceExhausted {
			t.Fatalf("legacy stream of the same user: %v, want RESOURCE_EXHAUSTED", err)
		}
	})
}

// The adapter converts through the wire format, which is only right while the two protos describe
// the same messages with the same numbers. Compare them, so that changing one without the other fails here.
func TestLegacyProtoMatchesTheCurrentOne(t *testing.T) {
	cur, old := notifyv1.File_clarae_v1_notify_proto, notifyv1legacy.File_memobrain_v1_notify_proto

	if got, want := describeMessages(old), describeMessages(cur); len(got) != len(want) || len(got) < 5 {
		t.Fatalf("messages: legacy %d, current %d", len(got), len(want))
	} else {
		for name, fields := range want {
			if got[name] != fields {
				t.Errorf("message %s: legacy %q, current %q", name, got[name], fields)
			}
		}
	}

	curServices, oldServices := cur.Services(), old.Services()
	if curServices.Len() != 1 || oldServices.Len() != 1 {
		t.Fatalf("services: current %d, legacy %d", curServices.Len(), oldServices.Len())
	}
	cm, om := curServices.Get(0).Methods(), oldServices.Get(0).Methods()
	if cm.Len() != om.Len() {
		t.Fatalf("methods: current %d, legacy %d", cm.Len(), om.Len())
	}
	for i := 0; i < cm.Len(); i++ {
		a, b := cm.Get(i), om.Get(i)
		if a.Name() != b.Name() || a.IsStreamingServer() != b.IsStreamingServer() || a.IsStreamingClient() != b.IsStreamingClient() ||
			a.Input().Name() != b.Input().Name() || a.Output().Name() != b.Output().Name() {
			t.Errorf("method %s differs between the current and the legacy service", a.Name())
		}
	}
}

// describeMessages maps each message name to a description of its fields (name, number, kind,
// cardinality, one-of and message type), in declaration order.
func describeMessages(f protoreflect.FileDescriptor) map[string]string {
	out := map[string]string{}
	ms := f.Messages()
	for i := 0; i < ms.Len(); i++ {
		m := ms.Get(i)
		var d string
		fs := m.Fields()
		for j := 0; j < fs.Len(); j++ {
			fd := fs.Get(j)
			d += fd.TextName() + ":" + fd.Kind().String() + ":" + fd.Cardinality().String()
			d += ":" + strconv.Itoa(int(fd.Number()))
			if fd.ContainingOneof() != nil {
				d += ":oneof=" + string(fd.ContainingOneof().Name())
			}
			if fd.Message() != nil {
				d += ":msg=" + string(fd.Message().Name())
			}
			if fd.IsMap() {
				d += ":map"
			}
			d += ";"
		}
		out[string(m.Name())] = d
	}
	return out
}
