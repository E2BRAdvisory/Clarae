package transport

import (
	"fmt"
	"net/http"
	"testing"
)

// The two 410 CURSOR_EXPIRED answers of GET /changes are told apart by their
// extension member (ADR-0046): last_seq for a server that went back in time,
// compaction_seq for a cursor older than the changelog window.
func TestServerBehind(t *testing.T) {
	gone := &http.Response{StatusCode: http.StatusGone, Header: http.Header{}}
	cases := []struct {
		name   string
		body   string
		behind bool
		seq    int64
	}{
		{"restored", `{"type":"about:blank","title":"Gone","status":410,"code":"CURSOR_EXPIRED","extra":{"last_seq":42}}`, true, 42},
		{"restored to an empty vault", `{"type":"about:blank","title":"Gone","status":410,"code":"CURSOR_EXPIRED","extra":{"last_seq":0}}`, true, 0},
		{"compacted", `{"type":"about:blank","title":"Gone","status":410,"code":"CURSOR_EXPIRED","extra":{"compaction_seq":42}}`, false, 0},
		{"no extra", `{"type":"about:blank","title":"Gone","status":410,"code":"CURSOR_EXPIRED"}`, false, 0},
		{"other code", `{"type":"about:blank","title":"Gone","status":410,"code":"NOT_FOUND","extra":{"last_seq":42}}`, false, 0},
		{"not a number", `{"type":"about:blank","title":"Gone","status":410,"code":"CURSOR_EXPIRED","extra":{"last_seq":"42"}}`, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := fmt.Errorf("changes: %w", problemOf(gone, []byte(tc.body)))
			if got := ServerBehind(err); got != tc.behind {
				t.Fatalf("ServerBehind = %v, want %v", got, tc.behind)
			}
			if n, ok := ExtraInt(err, "last_seq"); tc.behind && (!ok || n != tc.seq) {
				t.Fatalf("ExtraInt(last_seq) = %d, %v, want %d", n, ok, tc.seq)
			}
		})
	}
	if ServerBehind(nil) || ServerBehind(fmt.Errorf("network down")) {
		t.Fatal("a non-problem error is not a server that went back")
	}
}
