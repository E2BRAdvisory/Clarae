package revisions

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/revisions/revisionsdb"
)

func TestSelectDoomed(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	dailyCut := now.AddDate(0, 0, -90)
	fileA, fileB := uuid.New(), uuid.New()
	at := func(daysAgo, hour int) time.Time {
		d := now.AddDate(0, 0, -daysAgo)
		return time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, time.UTC)
	}
	row := func(f uuid.UUID, ts time.Time) revisionsdb.ListRevisionsForRetentionRow {
		return revisionsdb.ListRevisionsForRetentionRow{ID: uuid.New(), FileID: f, ServerTime: ts}
	}
	rows := []revisionsdb.ListRevisionsForRetentionRow{
		row(fileA, at(120, 9)), // older than 90 days: gone
		row(fileA, at(50, 8)),  // two revisions on one day: only the last stays
		row(fileA, at(50, 17)),
		row(fileA, at(40, 10)), // alone on its day: stays
		row(fileB, at(50, 17)), // same day as file A's, different file: stays
	}
	doomed := selectDoomed(rows, dailyCut)
	want := map[uuid.UUID]bool{rows[0].ID: true, rows[1].ID: true}
	if len(doomed) != len(want) {
		t.Fatalf("doomed %d, want %d", len(doomed), len(want))
	}
	for _, id := range doomed {
		if !want[id] {
			t.Errorf("unexpected deletion of %s", id)
		}
	}
}
