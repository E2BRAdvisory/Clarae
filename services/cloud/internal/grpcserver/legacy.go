package grpcserver

import (
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	"clarae/shared/notifyv1"
	"clarae/shared/notifyv1legacy"
)

// The desktop clients 1.4.0 and earlier call /memobrain.v1.NotifyService/Subscribe. Since 2.0 the
// service is clarae.v1.NotifyService, but a cloud that answered UNIMPLEMENTED to those clients
// would push them back to the SSE fallback for no reason. Both services run the same handler
// (notifyServer.serve: authentication, replay, ordering, rate limits and shutdown are shared);
// this adapter only converts the messages. The two protos are the same wire format by
// construction (api/proto/memobrain/v1 is a copy of api/proto/clarae/v1) and a test compares
// their descriptors. Dropped in 3.0 together with the legacy proto.

func registerLegacy(s *grpc.Server, n *notifyServer) {
	notifyv1legacy.RegisterNotifyServiceServer(s, &legacyNotifyServer{n: n})
}

type legacyNotifyServer struct {
	notifyv1legacy.UnimplementedNotifyServiceServer
	n *notifyServer
}

// Subscribe implements memobrain.v1.NotifyService/Subscribe.
func (l *legacyNotifyServer) Subscribe(req *notifyv1legacy.SubscribeRequest, stream grpc.ServerStreamingServer[notifyv1legacy.Event]) error {
	return l.n.serve(stream.Context(), req.GetKnownSeq(), req.GetConfigVersion(), func(ev *notifyv1.Event) error {
		out, err := legacyEvent(ev)
		if err != nil {
			return status.Error(codes.Internal, "event conversion failed")
		}
		return stream.Send(out)
	})
}

// legacyEvent converts an event to the message of the legacy package through the wire format,
// which the two packages share.
func legacyEvent(ev *notifyv1.Event) (*notifyv1legacy.Event, error) {
	b, err := proto.Marshal(ev)
	if err != nil {
		return nil, fmt.Errorf("marshal event: %w", err)
	}
	out := &notifyv1legacy.Event{}
	if err := proto.Unmarshal(b, out); err != nil {
		return nil, fmt.Errorf("unmarshal legacy event: %w", err)
	}
	return out, nil
}
