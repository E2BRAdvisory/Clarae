package configprofiles

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// The details of config.assignments.set are an object (the audit console
// drops anything else) with the profiles and priorities set.
func TestAssignmentsAuditIsAnObject(t *testing.T) {
	id := uuid.New()
	for _, as := range [][]Assignment{nil, {{ProfileID: id, Priority: 7}}} {
		raw, err := json.Marshal(assignmentsAudit(as))
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			Assignments []struct {
				ProfileID string `json:"profile_id"`
				Priority  int    `json:"priority"`
			} `json:"assignments"`
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if got.Assignments == nil || len(got.Assignments) != len(as) {
			t.Fatalf("details %s", raw)
		}
		if len(as) > 0 && (got.Assignments[0].ProfileID != id.String() || got.Assignments[0].Priority != 7) {
			t.Fatalf("details %s", raw)
		}
	}
}
