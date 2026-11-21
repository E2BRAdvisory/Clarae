package presence

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// Channel is the PostgreSQL NOTIFY channel replicas use to tell each other
// about their rooms.
const Channel = "presence"

// maxPayload keeps a NOTIFY well under the 8000 byte cap of PostgreSQL. A
// message is a few hundred bytes (identity, 256 byte position), so it is a
// safety net, not a limit anyone meets.
const maxPayload = 7500

// maxQueuedControl bounds the join and leave messages waiting to be sent; the
// heartbeat repairs whatever a database outage made us drop.
const maxQueuedControl = 100000

// batchSize is how many NOTIFY go in one round trip.
const batchSize = 500

// PGBus is the Bus over LISTEN/NOTIFY.
//
// Design: joins and leaves go out always, so that every replica knows every
// room (a few hundred bytes per member), and heartbeats repeat them every
// HeartbeatEvery. Moves go out only when the room has members on another
// replica (Hub.Move decides), coalesced latest-wins per (room, sender) and
// flushed at about 15 Hz. Nothing is written to a table. A NOTIFY lost while the
// listener is down is rebuilt by the hello that a replica sends when it
// listens again: the others answer by announcing their members, and the entries
// nobody refreshes expire after RemoteTTL.
type PGBus struct {
	pool *pgxpool.Pool
	log  zerolog.Logger
	hub  *Hub

	// RetryDelay is the pause before listening again after a loss (zero: 2 s).
	RetryDelay time.Duration

	mu    sync.Mutex
	ctl   []Wire
	moves map[moveKey]Wire
	order []moveKey
	wake  chan struct{}
}

// NewPGBus creates the bus of hub and installs it. Run drives it.
func NewPGBus(pool *pgxpool.Pool, log zerolog.Logger, hub *Hub) *PGBus {
	b := &PGBus{pool: pool, log: log, hub: hub, moves: map[moveKey]Wire{}, wake: make(chan struct{}, 1)}
	hub.SetBus(b)
	return b
}

func (b *PGBus) kick() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

func (b *PGBus) enqueue(w Wire) {
	w.Replica = b.hub.Replica()
	b.mu.Lock()
	if len(b.ctl) >= maxQueuedControl {
		b.mu.Unlock()
		return
	}
	b.ctl = append(b.ctl, w)
	b.mu.Unlock()
	b.kick()
}

// Join implements Bus.
func (b *PGBus) Join(room Room, m Member) {
	b.enqueue(Wire{Kind: WireJoin, Vault: room.Vault, File: room.File, SID: m.SID, User: m.User, Name: truncateName(m.Name)})
}

// Leave implements Bus.
func (b *PGBus) Leave(room Room, sid string) {
	b.enqueue(Wire{Kind: WireLeave, Vault: room.Vault, File: room.File, SID: sid})
}

// Move implements Bus.
func (b *PGBus) Move(room Room, sid string, pos json.RawMessage) {
	k := moveKey{room, sid}
	b.mu.Lock()
	if _, ok := b.moves[k]; !ok {
		b.order = append(b.order, k)
	}
	b.moves[k] = Wire{Replica: b.hub.Replica(), Kind: WireMove, Vault: room.Vault, File: room.File, SID: sid, Pos: pos}
	b.mu.Unlock()
	b.kick()
}

func (b *PGBus) take() []Wire {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Wire, 0, len(b.ctl)+len(b.order))
	out = append(out, b.ctl...)
	for _, k := range b.order {
		out = append(out, b.moves[k])
	}
	b.ctl, b.order, b.moves = nil, nil, map[moveKey]Wire{}
	return out
}

// flush sends the queued messages, one batch per round trip.
func (b *PGBus) flush(ctx context.Context) {
	msgs := b.take()
	if len(msgs) == 0 {
		return
	}
	for len(msgs) > 0 {
		n := min(batchSize, len(msgs))
		b.send(ctx, msgs[:n])
		msgs = msgs[n:]
	}
}

func (b *PGBus) send(ctx context.Context, msgs []Wire) {
	batch := &pgx.Batch{}
	for _, w := range msgs {
		raw, err := json.Marshal(w)
		if err != nil || len(raw) > maxPayload {
			continue
		}
		batch.Queue("SELECT pg_notify($1, $2)", Channel, string(raw))
	}
	if batch.Len() == 0 {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res := b.pool.SendBatch(cctx, batch)
	if err := res.Close(); err != nil && ctx.Err() == nil {
		b.log.Warn().Err(err).Msg("presence: cannot publish to the other replicas")
	}
}

func (b *PGBus) sender(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.wake:
		}
		// Let a burst gather: moves are coalesced for one flush interval.
		select {
		case <-ctx.Done():
			return
		case <-time.After(MoveFlushEvery):
		}
		b.flush(ctx)
	}
}

// Run sends and listens until ctx ends, listening again after a loss.
func (b *PGBus) Run(ctx context.Context) error {
	done := make(chan struct{})
	go func() { defer close(done); b.sender(ctx) }()
	delay := b.RetryDelay
	if delay <= 0 {
		delay = 2 * time.Second
	}
	for ctx.Err() == nil {
		if err := b.listen(ctx); err != nil && ctx.Err() == nil {
			b.log.Warn().Err(err).Msg("presence listener lost, reconnecting")
		}
		select {
		case <-ctx.Done():
		case <-time.After(delay):
		}
	}
	<-done
	return nil
}

func (b *PGBus) listen(ctx context.Context) error {
	conn, err := b.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "LISTEN "+Channel); err != nil {
		return err
	}
	b.log.Info().Msg("presence listener ready")
	// Ask the others for their members, and tell them ours.
	b.enqueue(Wire{Kind: WireHello})
	b.hub.Announce()
	for {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var w Wire
		if json.Unmarshal([]byte(n.Payload), &w) != nil {
			continue
		}
		b.hub.HandleRemote(w)
	}
}

// truncateName cuts a display name to MaxNameBytes without splitting a rune.
func truncateName(s string) string {
	if len(s) <= MaxNameBytes {
		return s
	}
	return strings.ToValidUTF8(s[:MaxNameBytes], "")
}

// Run does the periodic work of a hub until ctx ends: the heartbeat and the expiry of
// members that other replicas stopped announcing.
func (h *Hub) Run(ctx context.Context) {
	t := time.NewTicker(HeartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.Announce()
			h.Sweep()
		}
	}
}
