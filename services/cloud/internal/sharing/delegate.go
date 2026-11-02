package sharing

// Shares created by a manager (ADR-0041 §8, §3.5.4 "U (owner/manager)"): a user
// holding an accepted manager grant on a live share may share again what lies
// inside that share's scope, with grants up to manager. The new share belongs
// to the vault (its owner sees, manages and revokes it like any other);
// created_by records the manager, who manages it, without revoking it, for as
// long as they still manage a live share around it. When that grant goes
// (revoked, removed, expired share) the share stays and only its owner, or a
// manager granted on it, can change it; the creator keeps no grant of their own
// on it (putGrant refuses them, dropStaleCreatorGrants removes those another
// manager gave).

import (
	"context"
	"errors"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/sharing/sharingdb"
)

// target is the scope of a share, new or existing, as access.Scope.ContainsScope reads it.
type target struct {
	Type     string
	Prefix   string    // folder shares
	FileID   uuid.UUID // file shares
	FilePath string    // file shares: the current path of the document ("" once deleted)
}

// coveringShare returns the first of the shares a user manages whose scope
// contains t, leaving out skip (the share being checked itself).
func coveringShare(managed []sharingdb.Share, t target, skip uuid.UUID) (uuid.UUID, bool) {
	for _, m := range managed {
		if m.ID == skip {
			continue
		}
		if access.NewScope(m.ID, m.ResourceType, m.PathPrefix, m.FileID).ContainsScope(t.Type, t.Prefix, t.FileID, t.FilePath) {
			return m.ID, true
		}
	}
	return uuid.Nil, false
}

// targetOf reads the scope of an existing share; a document share needs the
// current path of its file to be placed inside a folder.
func targetOf(ctx context.Context, q *sharingdb.Queries, sh sharingdb.Share) (target, error) {
	t := target{Type: sh.ResourceType}
	if sh.PathPrefix != nil {
		t.Prefix = *sh.PathPrefix
	}
	if sh.FileID != nil {
		t.FileID = *sh.FileID
		f, err := q.GetFile(ctx, sharingdb.GetFileParams{ID: *sh.FileID, VaultID: sh.VaultID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return target{}, err
		}
		if err == nil && !f.IsDeleted {
			t.FilePath = f.Path
		}
	}
	return t, nil
}

// creatorManages reports whether viewer manages sh as the manager who created
// it: not the owner of the vault, and still holding an accepted manager grant
// on another live share of the vault whose scope contains sh.
func creatorManages(ctx context.Context, tx db.DBTX, sh sharingdb.Share, ownerID, viewer uuid.UUID) (bool, error) {
	if sh.CreatedBy != viewer || ownerID == viewer || sh.RevokedAt != nil {
		return false, nil
	}
	q := sharingdb.New(tx)
	managed, err := q.ListManagedSharesOfVault(ctx, sharingdb.ListManagedSharesOfVaultParams{VaultID: sh.VaultID, UserID: viewer})
	if err != nil || len(managed) == 0 {
		return false, err
	}
	t, err := targetOf(ctx, q, sh)
	if err != nil {
		return false, err
	}
	_, ok := coveringShare(managed, t, sh.ID)
	return ok, nil
}

// creatorManaged is creatorManages for the rows of a list, with one query for
// the managed shares of the viewer (and one per document share they created).
func creatorManaged(ctx context.Context, tx db.DBTX, rows []shareRow, viewer uuid.UUID) (map[uuid.UUID]bool, error) {
	out := map[uuid.UUID]bool{}
	var managed []sharingdb.Share
	loaded := false
	q := sharingdb.New(tx)
	for _, r := range rows {
		sh := r.share
		if sh.CreatedBy != viewer || r.ownerID == viewer || sh.RevokedAt != nil {
			continue
		}
		if !loaded {
			var err error
			if managed, err = q.ListManagedSharesOfUser(ctx, viewer); err != nil {
				return nil, err
			}
			loaded = true
		}
		var ofVault []sharingdb.Share
		for _, m := range managed {
			if m.VaultID == sh.VaultID {
				ofVault = append(ofVault, m)
			}
		}
		if len(ofVault) == 0 {
			continue
		}
		t, err := targetOf(ctx, q, sh)
		if err != nil {
			return nil, err
		}
		if _, ok := coveringShare(ofVault, t, sh.ID); ok {
			out[sh.ID] = true
		}
	}
	return out, nil
}

// dropStaleCreatorGrants removes the grants a manager holds, as a user, on the
// shares of a vault they created once they no longer manage a live share around
// them: having lost the management they stop seeing what they created, and a
// grant on it must not give the access back. Grants the owner gave stay (the
// owner's choice); a manager cannot grant themselves anything (putGrant), so
// the others came from another manager. It runs, in the transaction of the
// change, wherever a manager grant can go: a grant removed or lowered, a
// declined invitation, a revoked share, a member leaving a group, a group
// removed. An expiry takes effect without a write; by then the creator holds no
// grant of their own making to keep.
func (s *Service) dropStaleCreatorGrants(ctx context.Context, tx pgx.Tx, actor, vaultID uuid.UUID) error {
	q := sharingdb.New(tx)
	rows, err := q.ListCreatorGrantsOfVault(ctx, vaultID)
	if err != nil || len(rows) == 0 {
		return err
	}
	managed := map[uuid.UUID][]sharingdb.Share{}
	var dropped []sharingdb.Share
	for _, r := range rows {
		sh := r.Share
		m, ok := managed[sh.CreatedBy]
		if !ok {
			if m, err = q.ListManagedSharesOfVault(ctx, sharingdb.ListManagedSharesOfVaultParams{VaultID: vaultID, UserID: sh.CreatedBy}); err != nil {
				return err
			}
			managed[sh.CreatedBy] = m
		}
		t, err := targetOf(ctx, q, sh)
		if err != nil {
			return err
		}
		if _, ok := coveringShare(m, t, sh.ID); ok {
			continue
		}
		if err := q.DeleteGrantByID(ctx, r.GrantID); err != nil {
			return err
		}
		dropped = append(dropped, sh)
	}
	for _, sh := range dropped {
		if err := audit.Record(ctx, tx, actor, "grant.delete", "share", sh.ID.String(), map[string]any{"principal_type": "user", "principal_id": sh.CreatedBy, "reason": "creator_unmanaged"}); err != nil {
			return err
		}
		still, err := q.ListShareRecipients(ctx, sh.ID)
		if err != nil {
			return err
		}
		if !slices.Contains(still, sh.CreatedBy) {
			if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareRevoked, Share: sh.ID, Users: []uuid.UUID{sh.CreatedBy}}); err != nil {
				return err
			}
		}
		if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareUpdated, Share: sh.ID}); err != nil {
			return err
		}
	}
	return nil
}
