// Package notify turns Postgres NOTIFY messages into per-user event streams
// (M2-WP3): the commit transaction emits "vault_id:seq" on the channel
// vault_changed, a single LISTEN connection per process receives it and the
// hub fans it out in-process. Events only say "pull now": they are coalesced
// per vault, so a slow client never builds a backlog and never misses the
// latest position.
package notify

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"nodus/services/cloud/internal/db"
)

// Channel is the Postgres NOTIFY channel (mirrors sync.ChannelVaultChanged).
const Channel = "vault_changed"

// Event is "the vault reached this seq".
type Event struct {
	VaultID uuid.UUID
	Seq     int64
}

// Hub fans events out to subscribers.
type Hub struct {
	db  *db.DB
	log zerolog.Logger

	mu     sync.Mutex
	subs   map[*Sub]struct{}
	owners map[uuid.UUID]ownerEntry
}

type ownerEntry struct {
	owner   uuid.UUID
	deleted bool
	until   time.Time
}

// NewHub creates a hub; call Run to start listening.
func NewHub(d *db.DB, log zerolog.Logger) *Hub {
	return &Hub{db: d, log: log, subs: map[*Sub]struct{}{}, owners: map[uuid.UUID]ownerEntry{}}
}

// Sub is one subscriber's coalescing mailbox.
type Sub struct {
	user    uuid.UUID
	mu      sync.Mutex
	pending map[uuid.UUID]int64
	signal  chan struct{}
}

// Subscribe registers a subscriber for the user's vaults.
func (h *Hub) Subscribe(user uuid.UUID) *Sub {
	s := &Sub{user: user, pending: map[uuid.UUID]int64{}, signal: make(chan struct{}, 1)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

// Unsubscribe removes the subscriber.
func (h *Hub) Unsubscribe(s *Sub) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

func (s *Sub) push(ev Event) {
	s.mu.Lock()
	if ev.Seq > s.pending[ev.VaultID] {
		s.pending[ev.VaultID] = ev.Seq
	}
	s.mu.Unlock()
	select {
	case s.signal <- struct{}{}:
	default:
	}
}

// Push queues an event directly (used for the replay on connect).
func (s *Sub) Push(ev Event) { s.push(ev) }

// Next blocks until events are pending (or ctx ends) and returns them, at
// most one per vault, in no particular order.
func (s *Sub) Next(ctx context.Context) ([]Event, error) {
	for {
		s.mu.Lock()
		if len(s.pending) > 0 {
			out := make([]Event, 0, len(s.pending))
			for v, seq := range s.pending {
				out = append(out, Event{VaultID: v, Seq: seq})
			}
			s.pending = map[uuid.UUID]int64{}
			s.mu.Unlock()
			return out, nil
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-s.signal:
		}
	}
}

// ParseMessage decodes a NOTIFY payload "vault_id:seq".
func ParseMessage(payload string) (Event, bool) {
	id, seq, ok := strings.Cut(payload, ":")
	if !ok {
		return Event{}, false
	}
	vid, err := uuid.Parse(id)
	n, err2 := strconv.ParseInt(seq, 10, 64)
	if err != nil || err2 != nil {
		return Event{}, false
	}
	return Event{VaultID: vid, Seq: n}, true
}

// owner resolves the owner of a vault (cached briefly: ownership never
// changes, only deletion does, and that is rare).
func (h *Hub) owner(ctx context.Context, vault uuid.UUID) (uuid.UUID, bool) {
	h.mu.Lock()
	e, ok := h.owners[vault]
	h.mu.Unlock()
	if ok && time.Now().Before(e.until) {
		return e.owner, !e.deleted
	}
	row, err := h.db.Queries().GetVaultOwner(ctx, vault)
	if err != nil {
		return uuid.Nil, false
	}
	e = ownerEntry{owner: row.OwnerID, deleted: row.DeletedAt != nil, until: time.Now().Add(time.Minute)}
	h.mu.Lock()
	h.owners[vault] = e
	h.mu.Unlock()
	return e.owner, !e.deleted
}

// Dispatch delivers an event to the subscribers allowed to see the vault.
func (h *Hub) Dispatch(ctx context.Context, ev Event) {
	owner, ok := h.owner(ctx, ev.VaultID)
	if !ok {
		return
	}
	h.mu.Lock()
	targets := make([]*Sub, 0, 2)
	for s := range h.subs {
		if s.user == owner {
			targets = append(targets, s)
		}
	}
	h.mu.Unlock()
	for _, s := range targets {
		s.push(ev)
	}
}

// Snapshot returns the vaults of a user whose seq is ahead of what the client
// knows (replay after a reconnect, §3.6 known_seq).
func (h *Hub) Snapshot(ctx context.Context, user uuid.UUID, known map[string]int64) ([]Event, error) {
	rows, err := h.db.Queries().ListVaultsOfOwners(ctx, user)
	if err != nil {
		return nil, err
	}
	var out []Event
	for _, r := range rows {
		if r.LastSeq > known[r.ID.String()] {
			out = append(out, Event{VaultID: r.ID, Seq: r.LastSeq})
		}
	}
	return out, nil
}

// Run listens until ctx ends, reconnecting with a short delay after errors.
func (h *Hub) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		if err := h.listen(ctx, h.db.Pool); err != nil && ctx.Err() == nil {
			h.log.Warn().Err(err).Msg("notify listener lost, reconnecting")
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	return nil
}

func (h *Hub) listen(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "LISTEN "+Channel); err != nil {
		return err
	}
	h.log.Info().Msg("notify listener ready")
	for {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if ev, ok := ParseMessage(n.Payload); ok {
			h.Dispatch(ctx, ev)
		}
	}
}
