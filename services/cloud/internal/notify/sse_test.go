package notify

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestEndsStream(t *testing.T) {
	cases := []struct {
		ev   Event
		want bool
	}{
		{Event{Kind: KindAccount, AccountKind: AccountSuspended}, true},
		{Event{Kind: KindAccount, AccountKind: AccountActivated}, false},
		{Event{Kind: KindAccount, AccountKind: AccountQuotaChanged}, false},
		{Event{Kind: KindVault, VaultID: uuid.New(), Seq: 1}, false},
		{Event{Kind: KindShare, ShareKind: ShareRevoked}, false},
		{Event{Kind: KindConfig, Revision: 3}, false},
	}
	for _, c := range cases {
		if got := EndsStream(c.ev); got != c.want {
			t.Errorf("EndsStream(%+v) = %v, want %v", c.ev, got, c.want)
		}
	}
}

func TestWriteSSEBatchStopsAfterSuspension(t *testing.T) {
	v := uuid.New()
	var b strings.Builder
	end := writeSSEBatch(&b, []Event{
		{VaultID: v, Seq: 4},
		{Kind: KindAccount, AccountKind: AccountSuspended},
		{Kind: KindConfig, Revision: 9},
	})
	if !end {
		t.Fatal("a suspension must end the stream")
	}
	out := b.String()
	if !strings.Contains(out, `"seq":4`) || !strings.Contains(out, "event: account_changed\ndata: {\"kind\":\"suspended\"}\n\n") {
		t.Fatalf("events before and including the suspension must be written:\n%s", out)
	}
	if strings.Contains(out, "config_changed") {
		t.Fatalf("events after the suspension must be dropped:\n%s", out)
	}

	b.Reset()
	if writeSSEBatch(&b, []Event{{Kind: KindAccount, AccountKind: AccountQuotaChanged}, {VaultID: v, Seq: 5}}) {
		t.Fatal("a quota change must not end the stream")
	}
	if !strings.Contains(b.String(), "quota_changed") || !strings.Contains(b.String(), `"seq":5`) {
		t.Fatalf("unexpected output:\n%s", b.String())
	}
}
