// Package notify turns Postgres NOTIFY messages into per-user event streams
// (M2-WP3): the commit transaction emits "vault_id:seq" on the channel
// vault_changed, a single LISTEN connection per process receives it and the
// hub fans it out in-process. Events only say "pull now": they are coalesced
// per vault, so a slow client never builds a backlog and never misses the
// latest position.
package notify

import (
	"context"
	"slices"
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

// Kind tells what an Event is about.
type Kind int

// Event kinds; the zero value is a vault event.
const (
	KindVault Kind = iota
	KindShare
	KindConfig
	KindAccount
)

// Event is one notification: "the vault reached this seq" (the default kind),
// "a share was granted, revoked or updated", or "the configuration has a new revision".
type Event struct {
	Kind      Kind
	VaultID   uuid.UUID
	Seq       int64
	ShareID   uuid.UUID
	ShareKind string
	Revision  int64
	// AccountKind is set for KindAccount events.
	AccountKind string
}

// Hub fans events out to subscribers.
type Hub struct {
	db  *db.DB
	log zerolog.Logger

	mu         sync.Mutex
	subs       map[*Sub]struct{}
	owners     map[uuid.UUID]ownerEntry
	recipients map[uuid.UUID]recipientEntry
}

// recipientEntry caches who can read a vault through shares; share events drop it.
type recipientEntry struct {
	users map[uuid.UUID]bool
	until time.Time
}

const recipientTTL = 5 * time.Second

type ownerEntry struct {
	owner   uuid.UUID
	deleted bool
	until   time.Time
}

// NewHub creates a hub; call Run to start listening.
func NewHub(d *db.DB, log zerolog.Logger) *Hub {
	return &Hub{db: d, log: log, subs: map[*Sub]struct{}{}, owners: map[uuid.UUID]ownerEntry{}, recipients: map[uuid.UUID]recipientEntry{}}
}

// Sub is one subscriber's coalescing mailbox.
type Sub struct {
	user    uuid.UUID
	mu      sync.Mutex
	pending map[uuid.UUID]int64
	shares  []Event // share events are not coalesced by value, only de-duplicated
	config  int64
	account []string // account events, de-duplicated by kind
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
	switch ev.Kind {
	case KindShare:
		dup := false
		for _, e := range s.shares {
			if e.ShareID == ev.ShareID && e.ShareKind == ev.ShareKind {
				dup = true
			}
		}
		if !dup {
			s.shares = append(s.shares, ev)
		}
	case KindConfig:
		if ev.Revision > s.config {
			s.config = ev.Revision
		}
	case KindAccount:
		if !slices.Contains(s.account, ev.AccountKind) {
			s.account = append(s.account, ev.AccountKind)
		}
	default:
		if ev.Seq > s.pending[ev.VaultID] {
			s.pending[ev.VaultID] = ev.Seq
		}
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
		if len(s.pending) > 0 || len(s.shares) > 0 || s.config > 0 || len(s.account) > 0 {
			out := make([]Event, 0, len(s.pending)+len(s.shares)+1)
			for v, seq := range s.pending {
				out = append(out, Event{VaultID: v, Seq: seq})
			}
			out = append(out, s.shares...)
			if s.config > 0 {
				out = append(out, Event{Kind: KindConfig, Revision: s.config})
			}
			for _, k := range s.account {
				out = append(out, Event{Kind: KindAccount, AccountKind: k})
			}
			s.pending, s.shares, s.config, s.account = map[uuid.UUID]int64{}, nil, 0, nil
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

// sharedReaders returns the users who read a vault through accepted grants on live shares.
func (h *Hub) sharedReaders(ctx context.Context, vault uuid.UUID) map[uuid.UUID]bool {
	h.mu.Lock()
	e, ok := h.recipients[vault]
	h.mu.Unlock()
	if ok && time.Now().Before(e.until) {
		return e.users
	}
	ids, err := h.db.Queries().ListVaultRecipients(ctx, vault)
	if err != nil {
		h.log.Warn().Err(err).Msg("notify: cannot resolve share recipients")
		return e.users
	}
	users := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		users[id] = true
	}
	h.mu.Lock()
	h.recipients[vault] = recipientEntry{users: users, until: time.Now().Add(recipientTTL)}
	h.mu.Unlock()
	return users
}

func (h *Hub) deliver(users map[uuid.UUID]bool, ev Event) {
	h.mu.Lock()
	targets := make([]*Sub, 0, 2)
	for s := range h.subs {
		if users == nil || users[s.user] {
			targets = append(targets, s)
		}
	}
	h.mu.Unlock()
	for _, s := range targets {
		s.push(ev)
	}
}

// Dispatch delivers a vault event to the owner and to the users who reach the vault through a share.
func (h *Hub) Dispatch(ctx context.Context, ev Event) {
	owner, ok := h.owner(ctx, ev.VaultID)
	if !ok {
		return
	}
	users := map[uuid.UUID]bool{owner: true}
	for u := range h.sharedReaders(ctx, ev.VaultID) {
		users[u] = true
	}
	h.deliver(users, ev)
}

// DispatchShare delivers a share event: to the users it names, or to the owner and everyone
// holding a grant on the share. The cached recipients of vaults are dropped, since who can
// read what just changed.
func (h *Hub) DispatchShare(ctx context.Context, se ShareEvent) {
	h.mu.Lock()
	h.recipients = map[uuid.UUID]recipientEntry{}
	h.mu.Unlock()
	users := map[uuid.UUID]bool{}
	for _, u := range se.Users {
		users[u] = true
	}
	if len(se.Users) == 0 {
		q := h.db.Queries()
		sh, err := q.GetShare(ctx, se.Share)
		if err != nil {
			return
		}
		if owner, ok := h.owner(ctx, sh.VaultID); ok {
			users[owner] = true
		}
		ids, err := q.ListShareRecipients(ctx, se.Share)
		if err != nil {
			h.log.Warn().Err(err).Msg("notify: cannot resolve share recipients")
			return
		}
		for _, u := range ids {
			users[u] = true
		}
	}
	h.deliver(users, Event{Kind: KindShare, ShareID: se.Share, ShareKind: se.Kind})
}

// DispatchConfig tells every connected client that the configuration has a new revision.
func (h *Hub) DispatchConfig(revision int64) {
	h.deliver(nil, Event{Kind: KindConfig, Revision: revision})
}

// DispatchAccount tells one user's connected clients that their account changed.
func (h *Hub) DispatchAccount(ev AccountEvent) {
	h.deliver(map[uuid.UUID]bool{ev.User: true}, Event{Kind: KindAccount, AccountKind: ev.Kind})
}

// Snapshot returns what is ahead of what the client knows (replay after a reconnect, §3.6):
// the vaults of the user, the ones shared with them, and the configuration revision.
func (h *Hub) Snapshot(ctx context.Context, user uuid.UUID, known map[string]int64, configVersion int64) ([]Event, error) {
	q := h.db.Queries()
	rows, err := q.ListVaultsOfOwners(ctx, user)
	if err != nil {
		return nil, err
	}
	var out []Event
	seen := map[uuid.UUID]bool{}
	for _, r := range rows {
		seen[r.ID] = true
		if r.LastSeq > known[r.ID.String()] {
			out = append(out, Event{VaultID: r.ID, Seq: r.LastSeq})
		}
	}
	shared, err := q.ListSharedVaultSeqs(ctx, user)
	if err != nil {
		return nil, err
	}
	for _, r := range shared {
		if !seen[r.ID] && r.LastSeq > known[r.ID.String()] {
			seen[r.ID] = true
			out = append(out, Event{VaultID: r.ID, Seq: r.LastSeq})
		}
	}
	if rev, err := q.GetConfigRevision(ctx); err == nil && rev > configVersion {
		out = append(out, Event{Kind: KindConfig, Revision: rev})
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
	for _, ch := range []string{Channel, ChannelShare, ChannelConfig, ChannelAccount} {
		if _, err := conn.Exec(ctx, "LISTEN "+ch); err != nil {
			return err
		}
	}
	h.log.Info().Msg("notify listener ready")
	for {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}
		switch n.Channel {
		case ChannelShare:
			if se, ok := ParseShare(n.Payload); ok {
				h.DispatchShare(ctx, se)
			}
		case ChannelAccount:
			if ae, ok := ParseAccount(n.Payload); ok {
				h.DispatchAccount(ae)
			}
		case ChannelConfig:
			if rev, err := strconv.ParseInt(n.Payload, 10, 64); err == nil {
				h.DispatchConfig(rev)
			}
		default:
			if ev, ok := ParseMessage(n.Payload); ok {
				h.Dispatch(ctx, ev)
			}
		}
	}
}
