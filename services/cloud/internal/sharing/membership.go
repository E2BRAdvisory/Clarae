package sharing

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"clarae/services/cloud/internal/access"
	"clarae/services/cloud/internal/notify"
	"clarae/services/cloud/internal/sharing/sharingdb"
)

// GroupChange implements groups.Shares: change alters the members of a group
// or removes it, and the users listed (those it may concern) are told which
// shares they gained (granted) or lost (revoked) through it, as a grant added
// or removed tells them (DeleteGrant). A user still reached by another grant
// hears nothing. A manager who managed a share through the group stops
// managing what they created inside it (dropStaleCreatorGrants).
func (s *Service) GroupChange(ctx context.Context, tx pgx.Tx, actor, groupID uuid.UUID, users []uuid.UUID, change func() error) error {
	q := sharingdb.New(tx)
	shares, err := q.ListLiveSharesOfGroup(ctx, groupID)
	if err != nil {
		return err
	}
	if len(shares) == 0 || len(users) == 0 {
		return change()
	}
	ids := make([]uuid.UUID, 0, len(shares))
	for _, sh := range shares {
		ids = append(ids, sh.ID)
	}
	reach := func() (map[sharingdb.ListReachOfUsersRow]bool, error) {
		rows, err := q.ListReachOfUsers(ctx, sharingdb.ListReachOfUsersParams{ShareIds: ids, UserIds: users})
		if err != nil {
			return nil, err
		}
		out := make(map[sharingdb.ListReachOfUsersRow]bool, len(rows))
		for _, r := range rows {
			out[r] = true
		}
		return out, nil
	}
	before, err := reach()
	if err != nil {
		return err
	}
	if err := change(); err != nil {
		return err
	}
	after, err := reach()
	if err != nil {
		return err
	}
	for _, id := range ids {
		var gained, lost []uuid.UUID
		for _, u := range users {
			k := sharingdb.ListReachOfUsersRow{ShareID: id, UserID: u}
			switch {
			case after[k] && !before[k]:
				gained = append(gained, u)
			case before[k] && !after[k]:
				lost = append(lost, u)
			}
		}
		if len(gained) > 0 {
			if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareGranted, Share: id, Users: gained}); err != nil {
				return err
			}
		}
		if len(lost) > 0 {
			if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareRevoked, Share: id, Users: lost}); err != nil {
				return err
			}
		}
	}
	checked := map[uuid.UUID]bool{}
	for _, sh := range shares {
		if access.ParsePermission(sh.Permission) == access.Manager && !checked[sh.VaultID] {
			checked[sh.VaultID] = true
			if err := s.dropStaleCreatorGrants(ctx, tx, actor, sh.VaultID); err != nil {
				return err
			}
		}
	}
	return nil
}
