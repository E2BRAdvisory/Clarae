package notify

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
)

func TestParseMessage(t *testing.T) {
	id := uuid.New()
	ev, ok := ParseMessage(id.String() + ":42")
	if !ok || ev.VaultID != id || ev.Seq != 42 {
		t.Fatalf("got %v %v", ev, ok)
	}
	for _, bad := range []string{"", "x", id.String(), id.String() + ":x", "nope:1"} {
		if _, ok := ParseMessage(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestSubCoalescesPerVault(t *testing.T) {
	s := &Sub{pending: map[uuid.UUID]int64{}, signal: make(chan struct{}, 1)}
	a, b := uuid.New(), uuid.New()
	s.push(Event{VaultID: a, Seq: 1})
	s.push(Event{VaultID: a, Seq: 5})
	s.push(Event{VaultID: a, Seq: 3}) // an older event never lowers the position
	s.push(Event{VaultID: b, Seq: 2})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	evs, err := s.Next(ctx)
	if err != nil || len(evs) != 2 {
		t.Fatalf("events %v %v", evs, err)
	}
	for _, e := range evs {
		if (e.VaultID == a && e.Seq != 5) || (e.VaultID == b && e.Seq != 2) {
			t.Errorf("not coalesced: %v", e)
		}
	}
	short, c2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer c2()
	if _, err := s.Next(short); err == nil {
		t.Error("Next must block when nothing is pending")
	}
}

func TestFormatMessageRoundTrips(t *testing.T) {
	id := uuid.New()
	ev, ok := ParseMessage(FormatMessage(id, 9))
	if !ok || ev.VaultID != id || ev.Seq != 9 {
		t.Fatalf("got %v %v", ev, ok)
	}
}

func next(t *testing.T, s *Sub) []Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	evs, err := s.Next(ctx)
	if err != nil {
		t.Fatalf("no event: %v", err)
	}
	return evs
}

func idle(t *testing.T, s *Sub) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if evs, err := s.Next(ctx); err == nil {
		t.Fatalf("unexpected events %v", evs)
	}
}

func TestDeliverReachesOnlyTheTargetedUsers(t *testing.T) {
	h := NewHub(nil, zerolog.Nop())
	ada, bob := uuid.New(), uuid.New()
	a1, a2, b := h.Subscribe(ada), h.Subscribe(ada), h.Subscribe(bob)
	defer h.Unsubscribe(b)
	h.DispatchAccount(AccountEvent{User: ada, Kind: AccountQuotaChanged})
	for _, s := range []*Sub{a1, a2} {
		if evs := next(t, s); len(evs) != 1 || evs[0].AccountKind != AccountQuotaChanged {
			t.Fatalf("ada's streams: %v", evs)
		}
	}
	idle(t, b)
	h.DispatchConfig(4) // broadcast
	for _, s := range []*Sub{a1, a2, b} {
		if evs := next(t, s); evs[0].Revision != 4 {
			t.Fatalf("broadcast: %v", evs)
		}
	}
	h.Unsubscribe(a1)
	h.Unsubscribe(a2)
	h.mu.Lock()
	_, kept := h.subs[ada]
	h.mu.Unlock()
	if kept {
		t.Fatal("the index keeps a user without streams")
	}
}

func TestOpenCapsStreamsPerUser(t *testing.T) {
	h := NewHub(nil, zerolog.Nop())
	h.MaxStreamsPerUser = 2
	ada := uuid.New()
	s1, err1 := h.Open(ada)
	s2, err2 := h.Open(ada)
	if err1 != nil || err2 != nil {
		t.Fatal(err1, err2)
	}
	if _, err := h.Open(ada); !errors.Is(err, ErrTooManyStreams) {
		t.Fatalf("third stream: %v", err)
	}
	if _, err := h.Open(uuid.New()); err != nil {
		t.Fatalf("another user: %v", err)
	}
	h.Unsubscribe(s1)
	if _, err := h.Open(ada); err != nil {
		t.Fatalf("after closing one: %v", err)
	}
	h.Unsubscribe(s2)
	h.Unsubscribe(nil) // harmless
}

func TestListenerQueueCoalescesAndOverflowsIntoResync(t *testing.T) {
	h := NewHub(nil, zerolog.Nop())
	v := uuid.New()
	h.enqueueVault(Event{VaultID: v, Seq: 3})
	h.enqueueVault(Event{VaultID: v, Seq: 8})
	h.enqueueVault(Event{VaultID: v, Seq: 5})
	if len(h.vaults) != 1 || h.vaults[v] != 8 {
		t.Fatalf("queue %v", h.vaults)
	}
	for range maxQueuedShares {
		h.enqueueShare(ShareEvent{Kind: ShareUpdated, Share: uuid.New()})
	}
	if h.resync {
		t.Fatal("resync before the queue is full")
	}
	h.enqueueShare(ShareEvent{Kind: ShareUpdated, Share: uuid.New()})
	if !h.resync || len(h.shares) != 0 {
		t.Fatalf("overflow: resync=%v queued=%d", h.resync, len(h.shares))
	}
}

func TestSubTracksPositionsForResync(t *testing.T) {
	s := newSub(uuid.New())
	a, b := uuid.New(), uuid.New()
	s.seed(map[string]int64{a.String(): 10, "not-a-uuid": 3}, 2)
	s.push(Event{VaultID: a, Seq: 7}) // older than what the client knows
	s.push(Event{VaultID: b, Seq: 4})
	s.push(Event{Kind: KindConfig, Revision: 5})
	known, cfg := s.positions()
	if known[a.String()] != 10 || known[b.String()] != 4 || len(known) != 2 || cfg != 5 {
		t.Fatalf("positions %v %d", known, cfg)
	}
}

func TestSweepCachesDropsExpiredEntries(t *testing.T) {
	h := NewHub(nil, zerolog.Nop())
	old, fresh := uuid.New(), uuid.New()
	h.owners[old] = ownerEntry{until: time.Now().Add(-time.Second)}
	h.owners[fresh] = ownerEntry{until: time.Now().Add(time.Hour)}
	h.recipients[old] = recipientEntry{until: time.Now().Add(-time.Second)}
	h.sweepCaches()
	if _, ok := h.owners[old]; ok || len(h.owners) != 1 || len(h.recipients) != 0 {
		t.Fatalf("owners %v recipients %v", h.owners, h.recipients)
	}
	// Rate-limited: a second sweep right after does nothing.
	h.owners[old] = ownerEntry{until: time.Now().Add(-time.Second)}
	h.sweepCaches()
	if _, ok := h.owners[old]; !ok {
		t.Fatal("swept again within cacheSweepEvery")
	}
}
