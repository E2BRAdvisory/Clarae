package sharing

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// sharingdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/sharing/sharingdb"
	"memobrain/services/cloud/internal/vaults"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// Types of the exported queries.
type (
	ListGrantsOfUserRow = sharingdb.ListGrantsOfUserRow
	ListGrantsRow       = sharingdb.ListGrantsRow
	Share               = sharingdb.Share
)

// ListLiveSharesOfVault runs the ListLiveSharesOfVault query on tx.
func ListLiveSharesOfVault(ctx context.Context, tx db.DBTX, vaultID uuid.UUID) ([]Share, error) {
	return sharingdb.New(tx).ListLiveSharesOfVault(ctx, vaultID)
}

// RebasePrefixSharesParams is a folder rename (move_prefix) in a vault: every
// path at or below FromPath moves below ToPath.
type RebasePrefixSharesParams struct {
	VaultID  uuid.UUID
	FromPath string
	ToPath   string
}

// RebasePrefixShares carries the folder shares rooted at or below a renamed
// folder along with it, inside tx. A share matches by path key (pathrules.Key,
// as every scope check does), so a prefix stored with another case or Unicode
// form follows its folder; the new prefix keeps the share's own segments below
// the renamed folder.
func RebasePrefixShares(ctx context.Context, tx db.DBTX, arg RebasePrefixSharesParams) error {
	q := sharingdb.New(tx)
	rows, err := q.ListFolderSharesOfVault(ctx, arg.VaultID)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.PathPrefix == nil {
			continue
		}
		np, ok := rebasePrefix(*r.PathPrefix, arg.FromPath, arg.ToPath)
		if !ok || np == *r.PathPrefix {
			continue
		}
		if err := q.SetSharePrefix(ctx, sharingdb.SetSharePrefixParams{ID: r.ID, PathPrefix: &np}); err != nil {
			return err
		}
	}
	return nil
}

// rebasePrefix is the prefix of a folder share once the folder from is renamed
// to to; ok is false when the share lies elsewhere.
func rebasePrefix(prefix, from, to string) (string, bool) {
	if from == "" {
		return "", false
	}
	k, fk := pathrules.Key(prefix), pathrules.Key(from)
	if k != fk && !strings.HasPrefix(k, fk+"/") {
		return "", false
	}
	// Case folding may change the length of a segment, never the segments:
	// keep those of the share below the renamed folder.
	segs, n := strings.Split(prefix, "/"), strings.Count(from, "/")+1
	if len(segs) < n {
		return "", false
	}
	return strings.Join(append([]string{to}, segs[n:]...), "/"), true
}

// RecheckScope confirms, inside tx and under the vault lock its caller holds,
// that the share a write was authorised through (Authorize reads it before the
// lock) still stands as it was: live, reaching userID at the level need, with
// the same root. A share gone is NOT_FOUND and a level lowered FORBIDDEN, as
// Authorize answers; a share whose root moved meanwhile (a concurrent
// move_prefix rebased it) is INVALID_STATE: the paths of the request were
// resolved against the old root, so the client pulls and tries again.
func RecheckScope(ctx context.Context, tx db.DBTX, userID uuid.UUID, vault vaults.Vault, sc *access.Scope, need access.Permission) error {
	if sc == nil {
		return nil
	}
	q := sharingdb.New(tx)
	sh, err := q.GetShare(ctx, sc.ShareID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (sh.VaultID != vault.ID || !live(sh, time.Now()))) {
		return httpproblem.NotFound("share")
	}
	if err != nil {
		return err
	}
	if vault.OwnerID != userID {
		grants, err := q.ListUserGrantsOnShare(ctx, sharingdb.ListUserGrantsOnShareParams{ShareID: sh.ID, PrincipalID: userID})
		if err != nil {
			return err
		}
		perm := best(grants)
		if perm == access.None {
			return httpproblem.NotFound("share")
		}
		if perm < need {
			return httpproblem.Errorf(syncproto.CodeForbidden, "this share is %s: %s access is required", perm, need)
		}
	}
	if cur := access.NewScope(sh.ID, sh.ResourceType, sh.PathPrefix, sh.FileID); cur.Type != sc.Type || cur.Prefix != sc.Prefix || cur.FileID != sc.FileID {
		return httpproblem.Errorf(syncproto.CodeInvalidState, "the share moved while the request waited: pull its changes and try again")
	}
	return nil
}

// SeesGrants reports whether userID manages a share, and so sees its grants, as
// the view of the share decides: the owner, a manager with an accepted grant on
// it, or the manager who created it while they still manage a live share
// around it (ADR-0041 §8).
func SeesGrants(ctx context.Context, tx db.DBTX, shareID, userID uuid.UUID) (bool, error) {
	q := sharingdb.New(tx)
	sh, err := q.GetShare(ctx, shareID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	v, err := vaults.GetVault(ctx, tx, sh.VaultID)
	if err != nil {
		return false, err
	}
	var mine []sharingdb.ShareGrant
	if v.OwnerID != userID {
		if mine, err = q.ListUserGrantsOnShare(ctx, sharingdb.ListUserGrantsOnShareParams{ShareID: sh.ID, PrincipalID: userID}); err != nil {
			return false, err
		}
	}
	byCreator, err := creatorManages(ctx, tx, sh, v.OwnerID, userID)
	if err != nil {
		return false, err
	}
	out, ok := buildView(sh, v.Name, v.OwnerID, "", userID, mine, byCreator)
	return ok && out.canManage() && out.MyStatus != "pending", nil
}

// ListGrants runs the ListGrants query on tx.
func ListGrants(ctx context.Context, tx db.DBTX, shareID uuid.UUID) ([]ListGrantsRow, error) {
	return sharingdb.New(tx).ListGrants(ctx, shareID)
}

// ListGrantsOfUser runs the ListGrantsOfUser query on tx.
func ListGrantsOfUser(ctx context.Context, tx db.DBTX, principalID uuid.UUID) ([]ListGrantsOfUserRow, error) {
	return sharingdb.New(tx).ListGrantsOfUser(ctx, principalID)
}

// DeleteGrantsOfPrincipal removes every grant given to a user or a group (a
// deleted group, an erased account), inside tx.
func DeleteGrantsOfPrincipal(ctx context.Context, tx db.DBTX, principalType string, principalID uuid.UUID) error {
	_, err := sharingdb.New(tx).DeleteGrantsOfPrincipal(ctx, sharingdb.DeleteGrantsOfPrincipalParams{PrincipalType: principalType, PrincipalID: principalID})
	return err
}

// DeleteGrantsOfPrincipal implements groups.Shares.
func (s *Service) DeleteGrantsOfPrincipal(ctx context.Context, tx db.DBTX, principalType string, principalID uuid.UUID) error {
	return DeleteGrantsOfPrincipal(ctx, tx, principalType, principalID)
}
