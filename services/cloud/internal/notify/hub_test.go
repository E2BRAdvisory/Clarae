package notify

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
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
	s.push(Event{a, 1})
	s.push(Event{a, 5})
	s.push(Event{a, 3}) // an older event never lowers the position
	s.push(Event{b, 2})
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
