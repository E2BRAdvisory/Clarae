package notify

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"nodus/services/cloud/internal/auth"
)

// SSEHandler serves GET /events, the fallback for networks that block gRPC
// (§3.5.3). Authentication wraps it. Query "known" carries replay positions as
// "vault_id:seq,vault_id:seq". The stream ends when the access token expires;
// the client refreshes it and reconnects.
func (h *Hub) SSEHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		p := auth.MustPrincipal(r.Context())
		sub := h.Subscribe(p.UserID)
		defer h.Unsubscribe(sub)

		known := map[string]int64{}
		for _, kv := range strings.Split(r.URL.Query().Get("known"), ",") {
			if id, seq, ok := strings.Cut(kv, ":"); ok {
				if n, err := strconv.ParseInt(seq, 10, 64); err == nil {
					known[id] = n
				}
			}
		}
		replay, err := h.Snapshot(r.Context(), p.UserID, known)
		if err != nil {
			http.Error(w, "replay failed", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, ": connected\n\n")
		flusher.Flush()
		for _, ev := range replay {
			sub.Push(ev)
		}

		ctx := r.Context()
		if exp := auth.TokenExpiryFrom(ctx); !exp.IsZero() {
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, exp)
			defer cancel()
		}
		heartbeat := time.NewTicker(25 * time.Second)
		defer heartbeat.Stop()
		events := make(chan []Event)
		go func() {
			defer close(events)
			for {
				batch, err := sub.Next(ctx)
				if err != nil {
					return
				}
				select {
				case events <- batch:
				case <-ctx.Done():
					return
				}
			}
		}()
		for {
			select {
			case <-ctx.Done():
				_, _ = fmt.Fprint(w, "event: token-expired\ndata: {}\n\n")
				flusher.Flush()
				return
			case batch, ok := <-events:
				if !ok {
					return
				}
				for _, ev := range batch {
					_, _ = fmt.Fprintf(w, "event: vault_changed\ndata: {\"vault_id\":%q,\"seq\":%d}\n\n", ev.VaultID, ev.Seq)
				}
				flusher.Flush()
			case <-heartbeat.C:
				_, _ = fmt.Fprint(w, ": ping\n\n")
				flusher.Flush()
			}
		}
	})
}
