package notify

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"memobrain/services/cloud/internal/auth"
)

// SSEHandler serves GET /events, the fallback for networks that block gRPC
// (§3.5.3). Authentication wraps it. Query "known" carries replay positions as
// "vault_id:seq,vault_id:seq" and "config" the configuration revision the client holds. The stream ends when the access token expires;
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
		cfgVersion, _ := strconv.ParseInt(r.URL.Query().Get("config"), 10, 64)
		replay, err := h.Snapshot(r.Context(), p.UserID, known, cfgVersion)
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
				// Only an expired token deserves the event; a closed request (client gone,
				// server draining) just ends the stream and the client reconnects.
				if r.Context().Err() == nil {
					_, _ = fmt.Fprint(w, "event: token-expired\ndata: {}\n\n")
					flusher.Flush()
				}
				return
			case batch, ok := <-events:
				if !ok {
					return
				}
				for _, ev := range batch {
					switch ev.Kind {
					case KindShare:
						_, _ = fmt.Fprintf(w, "event: share_changed\ndata: {\"share_id\":%q,\"kind\":%q}\n\n", ev.ShareID, ev.ShareKind)
					case KindAccount:
						_, _ = fmt.Fprintf(w, "event: account_changed\ndata: {\"kind\":%q}\n\n", ev.AccountKind)
					case KindConfig:
						_, _ = fmt.Fprintf(w, "event: config_changed\ndata: {\"version\":%d}\n\n", ev.Revision)
					default:
						_, _ = fmt.Fprintf(w, "event: vault_changed\ndata: {\"vault_id\":%q,\"seq\":%d}\n\n", ev.VaultID, ev.Seq)
					}
				}
				flusher.Flush()
			case <-heartbeat.C:
				_, _ = fmt.Fprint(w, ": ping\n\n")
				flusher.Flush()
			}
		}
	})
}
