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
	doomed := selectDoomed(rows, dailyCut, false)
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

// Prune pages through the candidates: the last row of a page is only a
// lookahead, so a day split across two pages still keeps exactly its last
// revision.
func TestSelectDoomedAcrossPages(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	dailyCut := now.AddDate(0, 0, -90)
	file := uuid.New()
	day := now.AddDate(0, 0, -50)
	row := func(hour int) revisionsdb.ListRevisionsForRetentionRow {
		return revisionsdb.ListRevisionsForRetentionRow{ID: uuid.New(), FileID: file, ServerTime: day.Add(time.Duration(hour) * time.Hour)}
	}
	r1, r2, r3 := row(1), row(2), row(3)

	// Page 1 ends with r2: r1 has a same-day successor, r2 is left undecided.
	if got := selectDoomed([]revisionsdb.ListRevisionsForRetentionRow{r1, r2}, dailyCut, true); len(got) != 1 || got[0] != r1.ID {
		t.Fatalf("page 1 doomed %v, want only r1", got)
	}
	// Page 2 starts again from r2: it has a successor, r3 is the last of the day.
	if got := selectDoomed([]revisionsdb.ListRevisionsForRetentionRow{r2, r3}, dailyCut, false); len(got) != 1 || got[0] != r2.ID {
		t.Fatalf("page 2 doomed %v, want only r2", got)
	}
	// A lookahead row is never decided, not even when older than the window.
	old := revisionsdb.ListRevisionsForRetentionRow{ID: uuid.New(), FileID: file, ServerTime: now.AddDate(0, 0, -200)}
	if got := selectDoomed([]revisionsdb.ListRevisionsForRetentionRow{old}, dailyCut, true); len(got) != 0 {
		t.Fatalf("lookahead row decided: %v", got)
	}
}
