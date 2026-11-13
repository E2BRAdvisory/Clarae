package groups

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// groupsdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/groups/groupsdb"
)

// Types of the module's public API and of the exported queries.
type (
	Group               = groupsdb.Group
	ListGroupMembersRow = groupsdb.ListGroupMembersRow
	ListGroupsOfUserRow = groupsdb.ListGroupsOfUserRow
)

// GetGroup runs the GetGroup query on tx.
func GetGroup(ctx context.Context, tx db.DBTX, id uuid.UUID) (Group, error) {
	return groupsdb.New(tx).GetGroup(ctx, id)
}

// ListGroupsOfUser runs the ListGroupsOfUser query on tx.
func ListGroupsOfUser(ctx context.Context, tx db.DBTX, userID uuid.UUID) ([]ListGroupsOfUserRow, error) {
	return groupsdb.New(tx).ListGroupsOfUser(ctx, userID)
}
