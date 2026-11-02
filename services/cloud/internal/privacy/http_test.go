package privacy

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func sampleExport() Export {
	return Export{
		GeneratedAt: time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC), Notice: Notice,
		Profile: map[string]any{"username": "ada"}, Devices: []map[string]any{}, Groups: []map[string]any{},
		Vaults: []map[string]any{}, Shares: []map[string]any{}, ReceivedGrants: []map[string]any{{"permission": "editor"}},
	}
}

// The audit log is appended entry by entry as the last member of the
// document, which stays one valid JSON object however many entries there are.
func TestExportResponseStreamsTheAuditLog(t *testing.T) {
	for _, n := range []int{0, 1, 2500} {
		r := exportResponse{data: sampleExport(), audit: func(fn func(map[string]any) error) error {
			for i := range n {
				if err := fn(map[string]any{"id": i + 1, "action": "test", "details": map[string]any{"k": "<v>"}}); err != nil {
					return err
				}
			}
			return nil
		}}
		var buf bytes.Buffer
		if err := r.write(&buf); err != nil {
			t.Fatal(err)
		}
		var got map[string]any
		if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
			t.Fatalf("%d entries: invalid JSON: %v\n%s", n, err, buf.String())
		}
		log, ok := got["audit_log"].([]any)
		if !ok || len(log) != n {
			t.Fatalf("%d entries: audit_log %v", n, got["audit_log"])
		}
		if n > 0 && log[n-1].(map[string]any)["id"] != float64(n) {
			t.Fatalf("last entry %v", log[n-1])
		}
		if got["notice"] != Notice || len(got["received_grants"].([]any)) != 1 {
			t.Fatalf("other members lost: %v", got)
		}
	}
}

// A failure midway leaves an invalid document, never a shorter valid one.
func TestExportResponseTruncatesOnError(t *testing.T) {
	boom := errors.New("boom")
	r := exportResponse{data: sampleExport(), audit: func(fn func(map[string]any) error) error {
		if err := fn(map[string]any{"id": 1}); err != nil {
			return err
		}
		return boom
	}}
	var buf bytes.Buffer
	if err := r.write(&buf); !errors.Is(err, boom) {
		t.Fatalf("err %v", err)
	}
	if json.Valid(buf.Bytes()) {
		t.Fatalf("a truncated export is valid JSON: %s", buf.String())
	}
}
