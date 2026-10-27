// Package audit appends rows to audit_log (§3.5.5): every state-changing
// administrative or sharing action leaves a trace of who did what to what.
package audit

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/db/dbgen"
)

// Record writes one audit row through q, so it commits with the change it describes.
func Record(ctx context.Context, q *dbgen.Queries, actor uuid.UUID, action, targetType, targetID string, details any) error {
	var raw []byte
	if details != nil {
		b, err := json.Marshal(details)
		if err != nil {
			return err
		}
		raw = b
	}
	return q.InsertAudit(ctx, dbgen.InsertAuditParams{
		ActorID: &actor, Action: action, TargetType: &targetType, TargetID: &targetID, Details: raw,
	})
}
