// Package notify turns Postgres NOTIFY messages into per-user event streams
// (M2-WP3): the commit transaction emits "vault_id:seq" on the channel
// vault_changed, a single LISTEN connection per process receives it and the
// hub fans it out in-process. Events only say "pull now": they are coalesced
// per vault, so a slow client never builds a backlog and never misses the
// latest position.
//
// The listener goroutine never touches the database: it queues vault and
// share events for a dispatcher, which coalesces them per vault and resolves
// the recipients of a whole batch with one query. When the listening
// connection is lost, NOTIFYs sent meanwhile are gone (Postgres does not
// queue them for a session that is not listening): once listening again the
// hub resyncs every subscriber from the database (Resync).
package notify

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/notify/notifydb"
	"memobrain/services/cloud/internal/observability"
	"memobrain/services/cloud/internal/settings"
	"memobrain/services/cloud/internal/users"
)

// Channel is the Postgres NOTIFY channel of vault changes; PublishVaultChanged
// writes it and ParseMessage reads it.
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

// DefaultMaxStreamsPerUser is the default cap of Open: a desktop or a browser
// tab holds one stream, so a few dozen covers every device of a user while a
// runaway client cannot pile up goroutines that every event fans out to.
const DefaultMaxStreamsPerUser = 32

// ErrTooManyStreams is returned by Open when the user already holds
// MaxStreamsPerUser streams on this replica.
var ErrTooManyStreams = errors.New("too many notification streams for this user")

// Cache sizing of the vault resolutions (owners, share readers).
const (
	recipientTTL = 5 * time.Second
	ownerTTL     = time.Minute
	// cacheSweepEvery is how often the dispatcher drops expired entries, so
	// the caches hold only vaults that changed recently.
	cacheSweepEvery = time.Minute
	// maxQueuedShares bounds the share events waiting for the dispatcher; past
	// it the queue is dropped and every subscriber is resynced instead.
	maxQueuedShares = 10000
)

// Hub fans events out to subscribers.
type Hub struct {
	db  *db.DB
	log zerolog.Logger

	// MaxStreamsPerUser caps Open per user (zero: DefaultMaxStreamsPerUser).
	MaxStreamsPerUser int
	// RetryDelay is the pause before listening again after the connection
	// was lost (zero: 2 s).
	RetryDelay time.Duration

	mu   sync.Mutex
	subs map[uuid.UUID]map[*Sub]struct{} // by user

	cacheMu    sync.Mutex
	owners     map[uuid.UUID]ownerEntry
	recipients map[uuid.UUID]recipientEntry
	lastSweep  time.Time

	// The dispatcher's queue, filled by the listener.
	qmu    sync.Mutex
	vaults map[uuid.UUID]int64
	shares []ShareEvent
	resync bool
	wake   chan struct{}
}

// recipientEntry caches who can read a vault through shares; share events drop it.
type recipientEntry struct {
	users map[uuid.UUID]bool
	until time.Time
}

type ownerEntry struct {
	owner   uuid.UUID
	deleted bool
	until   time.Time
}

// NewHub creates a hub; call Run to start listening.
func NewHub(d *db.DB, log zerolog.Logger) *Hub {
	return &Hub{
		db: d, log: log,
		subs:   map[uuid.UUID]map[*Sub]struct{}{},
		owners: map[uuid.UUID]ownerEntry{}, recipients: map[uuid.UUID]recipientEntry{},
		vaults: map[uuid.UUID]int64{}, wake: make(chan struct{}, 1),
	}
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

	// The positions the subscriber knows or was sent, the starting point of
	// a resync (see Hub.Resync).
	known      map[uuid.UUID]int64
	configSeen int64
}

func newSub(user uuid.UUID) *Sub {
	return &Sub{user: user, pending: map[uuid.UUID]int64{}, known: map[uuid.UUID]int64{}, signal: make(chan struct{}, 1)}
}

// Subscribe registers a subscriber for the user's vaults, without a cap
// (in-process listeners and tests; network streams use Open).
func (h *Hub) Subscribe(user uuid.UUID) *Sub {
	s, _ := h.add(user, 0)
	return s
}

// Open registers the subscriber of a network stream, refusing it with
// ErrTooManyStreams when the user already holds MaxStreamsPerUser streams.
func (h *Hub) Open(user uuid.UUID) (*Sub, error) {
	limit := h.MaxStreamsPerUser
	if limit <= 0 {
		limit = DefaultMaxStreamsPerUser
	}
	return h.add(user, limit)
}

func (h *Hub) add(user uuid.UUID, limit int) (*Sub, error) {
	s := newSub(user)
	h.mu.Lock()
	set := h.subs[user]
	if limit > 0 && len(set) >= limit {
		h.mu.Unlock()
		return nil, ErrTooManyStreams
	}
	if set == nil {
		set = map[*Sub]struct{}{}
		h.subs[user] = set
	}
	set[s] = struct{}{}
	h.mu.Unlock()
	observability.StreamOpened()
	return s, nil
}

// Unsubscribe removes the subscriber.
func (h *Hub) Unsubscribe(s *Sub) {
	if s == nil {
		return
	}
	h.mu.Lock()
	set := h.subs[s.user]
	_, was := set[s]
	delete(set, s)
	if len(set) == 0 {
		delete(h.subs, s.user)
	}
	h.mu.Unlock()
	if was {
		observability.StreamClosed()
	}
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
		if ev.Revision > s.configSeen {
			s.configSeen = ev.Revision
		}
	case KindAccount:
		if !slices.Contains(s.account, ev.AccountKind) {
			s.account = append(s.account, ev.AccountKind)
		}
	default:
		if ev.Seq > s.pending[ev.VaultID] {
			s.pending[ev.VaultID] = ev.Seq
		}
		if s.known == nil {
			s.known = map[uuid.UUID]int64{}
		}
		if ev.Seq > s.known[ev.VaultID] {
			s.known[ev.VaultID] = ev.Seq
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

// seed records the positions the client said it knows when it connected.
func (s *Sub) seed(known map[string]int64, configVersion int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.known == nil {
		s.known = map[uuid.UUID]int64{}
	}
	for id, seq := range known {
		if v, err := uuid.Parse(id); err == nil && seq > s.known[v] {
			s.known[v] = seq
		}
	}
	if configVersion > s.configSeen {
		s.configSeen = configVersion
	}
}

// positions returns what the subscriber knows, in the form Snapshot takes.
func (s *Sub) positions() (map[string]int64, int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]int64, len(s.known))
	for v, seq := range s.known {
		out[v.String()] = seq
	}
	return out, s.configSeen
}

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

// FormatMessage encodes a vault_changed payload "vault_id:seq".
func FormatMessage(vault uuid.UUID, seq int64) string {
	return vault.String() + ":" + strconv.FormatInt(seq, 10)
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

// PublishVaultChanged announces that a vault reached seq when the surrounding
// transaction commits. One notification per transaction is enough: it
// carries the highest seq, and the hub coalesces per vault anyway.
func PublishVaultChanged(ctx context.Context, tx pgx.Tx, vault uuid.UUID, seq int64) error {
	_, err := tx.Exec(ctx, "SELECT pg_notify($1, $2)", Channel, FormatMessage(vault, seq))
	return err
}

// resolve returns, for each vault of the batch, the users to notify: the
// owner of a live vault and everyone reading it through an accepted grant.
// Cached answers are reused; the rest is fetched with two queries for the
// whole batch. A deleted or unknown vault has no entry.
func (h *Hub) resolve(ctx context.Context, ids []uuid.UUID) map[uuid.UUID]map[uuid.UUID]bool {
	now := time.Now()
	owners := make(map[uuid.UUID]ownerEntry, len(ids))
	readers := make(map[uuid.UUID]map[uuid.UUID]bool, len(ids))
	var missOwner, missReaders []uuid.UUID
	h.cacheMu.Lock()
	for _, id := range ids {
		if e, ok := h.owners[id]; ok && now.Before(e.until) {
			owners[id] = e
		} else {
			missOwner = append(missOwner, id)
		}
		if e, ok := h.recipients[id]; ok && now.Before(e.until) {
			readers[id] = e.users
		} else {
			missReaders = append(missReaders, id)
		}
	}
	h.cacheMu.Unlock()

	if len(missOwner) > 0 {
		rows, err := notifydb.New(h.db.Pool).GetVaultOwners(ctx, missOwner)
		if err != nil {
			h.log.Warn().Err(err).Msg("notify: cannot resolve vault owners")
		}
		h.cacheMu.Lock()
		for _, r := range rows {
			e := ownerEntry{owner: r.OwnerID, deleted: r.DeletedAt != nil, until: now.Add(ownerTTL)}
			owners[r.ID] = e
			h.owners[r.ID] = e
		}
		h.cacheMu.Unlock()
	}
	if len(missReaders) > 0 {
		rows, err := notifydb.New(h.db.Pool).ListVaultsRecipients(ctx, missReaders)
		if err != nil {
			// Keep the stale answer (if any) rather than notifying nobody.
			h.log.Warn().Err(err).Msg("notify: cannot resolve share recipients")
			h.cacheMu.Lock()
			for _, id := range missReaders {
				if e, ok := h.recipients[id]; ok {
					readers[id] = e.users
				}
			}
			h.cacheMu.Unlock()
		} else {
			fresh := make(map[uuid.UUID]map[uuid.UUID]bool, len(missReaders))
			for _, id := range missReaders {
				fresh[id] = map[uuid.UUID]bool{}
			}
			for _, r := range rows {
				fresh[r.VaultID][r.UserID] = true
			}
			h.cacheMu.Lock()
			for id, us := range fresh {
				readers[id] = us
				h.recipients[id] = recipientEntry{users: us, until: now.Add(recipientTTL)}
			}
			h.cacheMu.Unlock()
		}
	}

	out := make(map[uuid.UUID]map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		o, ok := owners[id]
		if !ok || o.deleted {
			continue
		}
		us := map[uuid.UUID]bool{o.owner: true}
		for u := range readers[id] {
			us[u] = true
		}
		out[id] = us
	}
	return out
}

// sweepCaches drops expired cache entries, at most once per cacheSweepEvery.
func (h *Hub) sweepCaches() {
	now := time.Now()
	h.cacheMu.Lock()
	defer h.cacheMu.Unlock()
	if now.Sub(h.lastSweep) < cacheSweepEvery {
		return
	}
	h.lastSweep = now
	for id, e := range h.owners {
		if now.After(e.until) {
			delete(h.owners, id)
		}
	}
	for id, e := range h.recipients {
		if now.After(e.until) {
			delete(h.recipients, id)
		}
	}
}

// deliver pushes ev to every subscriber of the given users (all subscribers
// when users is nil). The subscriber index is by user, so a targeted event
// costs a map lookup per user, not a scan of every stream.
func (h *Hub) deliver(users map[uuid.UUID]bool, ev Event) {
	var targets []*Sub
	h.mu.Lock()
	if users == nil {
		for _, set := range h.subs {
			for s := range set {
				targets = append(targets, s)
			}
		}
	} else {
		for u := range users {
			for s := range h.subs[u] {
				targets = append(targets, s)
			}
		}
	}
	h.mu.Unlock()
	for _, s := range targets {
		s.push(ev)
	}
}

// Dispatch delivers a vault event to the owner and to the users who reach the vault through a share.
func (h *Hub) Dispatch(ctx context.Context, ev Event) {
	h.dispatchVaults(ctx, map[uuid.UUID]int64{ev.VaultID: ev.Seq})
}

// dispatchVaults delivers one coalesced batch of vault events.
func (h *Hub) dispatchVaults(ctx context.Context, batch map[uuid.UUID]int64) {
	ids := make([]uuid.UUID, 0, len(batch))
	for id := range batch {
		ids = append(ids, id)
	}
	for id, us := range h.resolve(ctx, ids) {
		h.deliver(us, Event{VaultID: id, Seq: batch[id]})
	}
}

// DispatchShare delivers a share event: to the users it names, or to the owner and everyone
// holding a grant on the share. The cached recipients of the share's vault are dropped, since
// who can read it just changed.
func (h *Hub) DispatchShare(ctx context.Context, se ShareEvent) {
	q := notifydb.New(h.db.Pool)
	sh, shareErr := q.GetShare(ctx, se.Share)
	h.cacheMu.Lock()
	if shareErr == nil {
		delete(h.recipients, sh.VaultID)
	} else {
		// The vault is unknown (share gone, database error): drop them all.
		h.recipients = map[uuid.UUID]recipientEntry{}
	}
	h.cacheMu.Unlock()
	users := map[uuid.UUID]bool{}
	for _, u := range se.Users {
		users[u] = true
	}
	if len(se.Users) == 0 {
		if shareErr != nil {
			return
		}
		if us, ok := h.resolve(ctx, []uuid.UUID{sh.VaultID})[sh.VaultID]; ok {
			for u := range us {
				users[u] = true // the owner, and readers through other shares (harmless)
			}
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
	q := notifydb.New(h.db.Pool)
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
	if rev, err := settings.ConfigRevision(ctx, h.db.Pool); err == nil && rev > configVersion {
		out = append(out, Event{Kind: KindConfig, Revision: rev})
	}
	return out, nil
}

// Replay queues on sub what is ahead of the positions its client reported
// when connecting, and records those positions for a later Resync.
func (h *Hub) Replay(ctx context.Context, sub *Sub, known map[string]int64, configVersion int64) error {
	sub.seed(known, configVersion)
	evs, err := h.Snapshot(ctx, sub.user, known, configVersion)
	if err != nil {
		return err
	}
	for _, ev := range evs {
		sub.push(ev)
	}
	return nil
}

// Resync brings every subscriber up to date from the database, for events
// that may have been lost (the listening connection dropped, or the share
// queue overflowed): each one gets the vaults and configuration revision
// ahead of what it knows, and the streams of an account suspended or deleted
// meanwhile get the suspension event that closes them. Share events cannot
// be replayed; a vault newly shared with a user shows up as a vault event,
// and a revoked one answers NOT_FOUND on the next pull.
func (h *Hub) Resync(ctx context.Context) {
	h.mu.Lock()
	byUser := make(map[uuid.UUID][]*Sub, len(h.subs))
	for u, set := range h.subs {
		for s := range set {
			byUser[u] = append(byUser[u], s)
		}
	}
	h.mu.Unlock()
	n := 0
	for u, subs := range byUser {
		if ctx.Err() != nil {
			return
		}
		if b, err := users.GetUserBrief(ctx, h.db.Pool, u); err == nil && (b.Status == "suspended" || b.Status == "deleted") {
			for _, s := range subs {
				s.push(Event{Kind: KindAccount, AccountKind: AccountSuspended})
			}
			continue
		}
		for _, s := range subs {
			known, cfg := s.positions()
			evs, err := h.Snapshot(ctx, u, known, cfg)
			if err != nil {
				h.log.Warn().Err(err).Str("user_id", u.String()).Msg("notify: resync failed")
				continue
			}
			for _, ev := range evs {
				s.push(ev)
			}
			n += len(evs)
		}
	}
	h.log.Info().Int("users", len(byUser)).Int("events", n).Msg("notify: subscribers resynced")
}

// enqueueVault queues a vault event for the dispatcher (coalesced per vault).
func (h *Hub) enqueueVault(ev Event) {
	h.qmu.Lock()
	if ev.Seq > h.vaults[ev.VaultID] {
		h.vaults[ev.VaultID] = ev.Seq
	}
	h.qmu.Unlock()
	h.kick()
}

// enqueueShare queues a share event; an overflowing queue turns into a resync.
func (h *Hub) enqueueShare(se ShareEvent) {
	h.qmu.Lock()
	if len(h.shares) >= maxQueuedShares {
		h.shares, h.resync = nil, true
	} else {
		h.shares = append(h.shares, se)
	}
	h.qmu.Unlock()
	h.kick()
}

// requestResync asks the dispatcher to run Resync.
func (h *Hub) requestResync() {
	h.qmu.Lock()
	h.resync = true
	h.qmu.Unlock()
	h.kick()
}

func (h *Hub) kick() {
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

// dispatch runs the queued work until ctx ends. Share events go first: they
// drop cached recipients the vault events of the same batch must not use.
func (h *Hub) dispatch(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.wake:
		}
		h.qmu.Lock()
		vaults, shares, resync := h.vaults, h.shares, h.resync
		h.vaults, h.shares, h.resync = map[uuid.UUID]int64{}, nil, false
		h.qmu.Unlock()
		for _, se := range shares {
			h.DispatchShare(ctx, se)
		}
		if len(vaults) > 0 {
			h.dispatchVaults(ctx, vaults)
		}
		if resync {
			h.Resync(ctx)
		}
		h.sweepCaches()
	}
}

// Run listens until ctx ends, reconnecting with a short delay after errors,
// and resyncs the subscribers every time listening resumes after a loss.
func (h *Hub) Run(ctx context.Context) error {
	done := make(chan struct{})
	go func() { defer close(done); h.dispatch(ctx) }()
	delay := h.RetryDelay
	if delay <= 0 {
		delay = 2 * time.Second
	}
	lost := false
	for ctx.Err() == nil {
		ready := func() {
			if lost {
				h.log.Info().Msg("notify listener reconnected")
				h.requestResync()
			}
		}
		if err := h.listen(ctx, h.db.Pool, ready); err != nil && ctx.Err() == nil {
			h.log.Warn().Err(err).Msg("notify listener lost, reconnecting")
			lost = true
		}
		select {
		case <-ctx.Done():
		case <-time.After(delay):
		}
	}
	<-done
	return nil
}

// listen holds one connection in LISTEN on every channel and queues what
// arrives; ready runs once the LISTENs are in place.
func (h *Hub) listen(ctx context.Context, pool *pgxpool.Pool, ready func()) error {
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
	ready()
	for {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}
		switch n.Channel {
		case ChannelShare:
			if se, ok := ParseShare(n.Payload); ok {
				h.enqueueShare(se)
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
				h.enqueueVault(ev)
			}
		}
	}
}
