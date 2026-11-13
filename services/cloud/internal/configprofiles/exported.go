package configprofiles

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// configprofilesdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/configprofiles/configprofilesdb"
	"clarae/services/cloud/internal/db"
)

// Types of the module's public API and of the exported queries.
type (
	ConfigProfile        = configprofilesdb.ConfigProfile
	ConfigProfileVersion = configprofilesdb.ConfigProfileVersion
	// ProfileVersionSummary is a version without its configuration (Versions).
	ProfileVersionSummary = configprofilesdb.ListProfileVersionsRow
	ConfigAssignment      = configprofilesdb.ConfigAssignment
)

// ListGroupAssignments runs the ListGroupAssignments query on tx.
func ListGroupAssignments(ctx context.Context, tx db.DBTX, groupID uuid.UUID) ([]ConfigAssignment, error) {
	return configprofilesdb.New(tx).ListGroupAssignments(ctx, groupID)
}
