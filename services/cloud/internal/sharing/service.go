package sharing

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/groups"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/pagination"
	"memobrain/services/cloud/internal/sharing/sharingdb"
	"memobrain/services/cloud/internal/users"
	"memobrain/services/cloud/internal/vaults"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// NewGrant is a grant given while creating a share or adding one later.
type NewGrant struct {
	PrincipalType string // user | group
	PrincipalID   uuid.UUID
	Permission    access.Permission
}

// CreateInput describes a new share.
type CreateInput struct {
	VaultID      uuid.UUID
	ResourceType string
	PathPrefix   string
	FileID       uuid.UUID
	DisplayName  string
	ExpiresAt    *time.Time
	Grants       []NewGrant
}

// View is a share as seen by one user.
type View struct {
	Share        sharingdb.Share
	VaultName    string
	OwnerID      uuid.UUID
	OwnerName    string
	MyPermission access.Permission // None for the owner: see IsOwner
	MyStatus     string            // accepted | pending | declined; "" for the owner
	IsOwner      bool
	// ByCreator is set when the viewer manages the share as the manager who
	// created it (ADR-0041 §8): MyPermission is then at least manager.
	ByCreator bool
	// Grants is filled for the owner and for managers.
	Grants []sharingdb.ListGrantsRow
}

func (v View) canManage() bool { return v.IsOwner || v.MyPermission >= access.Manager }

func validPrincipal(t string) bool { return t == "user" || t == "group" }

func validName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" || len([]rune(n)) > 120 {
		return "", httpproblem.Errorf(syncproto.CodeValidationFailed, "a share name has 1..120 characters")
	}
	return n, nil
}

func checkViolation(err error, msg string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23514" && strings.Contains(pg.Message, msg)
}

// Create shares a vault, a folder or a document of a shared vault. The caller is
// the owner of the vault, or a manager (ADR-0041 §8): someone holding an
// accepted manager grant on a live share of the vault whose scope contains the
// new one; their grants are capped at manager like everyone's (putGrant).
func (s *Service) Create(ctx context.Context, actor uuid.UUID, in CreateInput) (View, error) {
	name, err := validName(in.DisplayName)
	if err != nil {
		return View{}, err
	}
	if in.ExpiresAt != nil && !in.ExpiresAt.After(time.Now()) {
		return View{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "expires_at must be in the future")
	}
	var id uuid.UUID
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := sharingdb.New(tx)
		v, err := vaults.GetVault(ctx, tx, in.VaultID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && v.DeletedAt != nil) {
			return httpproblem.NotFound("vault")
		}
		if err != nil {
			return err
		}
		// A manager creates only inside what they manage; to anyone else the vault does not exist.
		var managed []sharingdb.Share
		if v.OwnerID != actor {
			if managed, err = q.ListManagedSharesOfVault(ctx, sharingdb.ListManagedSharesOfVaultParams{VaultID: v.ID, UserID: actor}); err != nil {
				return err
			}
			if len(managed) == 0 {
				return httpproblem.NotFound("vault")
			}
		}
		if v.Kind != "shared" {
			return httpproblem.Errorf(syncproto.CodeVaultEncrypted, "a private vault cannot be shared")
		}
		params := sharingdb.CreateShareParams{ID: uuid.Must(uuid.NewV7()), VaultID: v.ID, ResourceType: in.ResourceType, DisplayName: name, CreatedBy: actor, ExpiresAt: in.ExpiresAt}
		t := target{Type: in.ResourceType}
		switch in.ResourceType {
		case access.ResourceVault:
		case access.ResourceFolder:
			prefix, err := pathrules.Normalize(in.PathPrefix)
			if err != nil {
				return httpproblem.Errorf(syncproto.CodePathInvalid, "path_prefix: %v", err)
			}
			n, err := q.CountFilesUnderPrefix(ctx, sharingdb.CountFilesUnderPrefixParams{VaultID: v.ID, Exact: pathrules.Key(prefix), Descendants: likeEscape(pathrules.Key(prefix)) + "/%"})
			if err != nil {
				return err
			}
			if n == 0 {
				return httpproblem.Errorf(syncproto.CodeNotFound, "there are no files under %s", prefix)
			}
			params.PathPrefix, t.Prefix = &prefix, prefix
		case access.ResourceFile:
			f, err := q.GetFile(ctx, sharingdb.GetFileParams{ID: in.FileID, VaultID: v.ID})
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && f.IsDeleted) {
				return httpproblem.NotFound("file")
			}
			if err != nil {
				return err
			}
			params.FileID, t.FileID, t.FilePath = &f.ID, f.ID, f.Path
		default:
			return httpproblem.Errorf(syncproto.CodeValidationFailed, "resource_type must be vault, folder or file")
		}
		detail := map[string]any{"vault": v.ID, "type": in.ResourceType, "name": name}
		if v.OwnerID != actor {
			via, ok := coveringShare(managed, t, uuid.Nil)
			if !ok {
				return httpproblem.Errorf(syncproto.CodeForbidden, "a manager can share only what lies inside a share they manage")
			}
			detail["via_share"] = via
		}
		sh, err := q.CreateShare(ctx, params)
		if checkViolation(err, "VAULT_ENCRYPTED") {
			return httpproblem.Errorf(syncproto.CodeVaultEncrypted, "a private vault cannot be shared")
		}
		if err != nil {
			return err
		}
		id = sh.ID
		for _, g := range in.Grants {
			if err := s.putGrant(ctx, tx, actor, v, sh.ID, g); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, actor, "share.create", "share", sh.ID.String(), detail); err != nil {
			return err
		}
		return notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareGranted, Share: sh.ID})
	})
	if err != nil {
		return View{}, err
	}
	return s.Get(ctx, actor, id)
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// putGrant validates and writes one grant (a new one starts pending, a declined
// one asks again). A manager gives nothing to themselves, directly or through a
// group they belong to (ADR-0041 §8): such a grant would outlive the manager
// grant the owner can take back.
func (s *Service) putGrant(ctx context.Context, tx db.DBTX, actor uuid.UUID, v vaults.Vault, shareID uuid.UUID, g NewGrant) error {
	q := sharingdb.New(tx)
	if !validPrincipal(g.PrincipalType) || g.Permission < access.Viewer || g.Permission > access.Manager {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "a grant needs a user or group and a level of viewer, editor or manager")
	}
	switch g.PrincipalType {
	case "user":
		if g.PrincipalID == v.OwnerID {
			return httpproblem.Errorf(syncproto.CodeValidationFailed, "the owner already has full access")
		}
		if g.PrincipalID == actor {
			return httpproblem.Errorf(syncproto.CodeForbidden, "a manager cannot grant access to themselves")
		}
		u, err := users.GetUserBrief(ctx, tx, g.PrincipalID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && u.Status != "active") {
			return httpproblem.NotFound("user")
		}
		if err != nil {
			return err
		}
	case "group":
		if _, err := groups.GetGroup(ctx, tx, g.PrincipalID); errors.Is(err, pgx.ErrNoRows) {
			return httpproblem.NotFound("group")
		} else if err != nil {
			return err
		}
		if actor != v.OwnerID {
			mine, err := groups.ListGroupsOfUser(ctx, tx, actor)
			if err != nil {
				return err
			}
			for _, m := range mine {
				if m.ID == g.PrincipalID {
					return httpproblem.Errorf(syncproto.CodeForbidden, "a manager cannot grant access to a group they belong to")
				}
			}
		}
	}
	_, err := q.UpsertGrant(ctx, sharingdb.UpsertGrantParams{
		ID: uuid.Must(uuid.NewV7()), ShareID: shareID, PrincipalType: g.PrincipalType, PrincipalID: g.PrincipalID,
		Permission: g.Permission.String(), Status: "pending", GrantedBy: actor,
	})
	return err
}

// view assembles a share for a viewer; a viewer with no link to the share learns nothing.
func (s *Service) view(ctx context.Context, tx db.DBTX, sh sharingdb.Share, viewer uuid.UUID) (View, error) {
	q := sharingdb.New(tx)
	v, err := vaults.GetVault(ctx, tx, sh.VaultID)
	if err != nil {
		return View{}, err
	}
	owner, err := users.GetUserBrief(ctx, tx, v.OwnerID)
	if err != nil {
		return View{}, err
	}
	var mine []sharingdb.ShareGrant
	if v.OwnerID != viewer {
		if mine, err = q.ListUserGrantsOnShare(ctx, sharingdb.ListUserGrantsOnShareParams{ShareID: sh.ID, PrincipalID: viewer}); err != nil {
			return View{}, err
		}
	}
	byCreator, err := creatorManages(ctx, tx, sh, v.OwnerID, viewer)
	if err != nil {
		return View{}, err
	}
	out, ok := buildView(sh, v.Name, v.OwnerID, owner.Username, viewer, mine, byCreator)
	if !ok {
		return View{}, httpproblem.NotFound("share")
	}
	if out.canManage() && out.MyStatus != "pending" {
		out.Grants, err = q.ListGrants(ctx, sh.ID)
		if err != nil {
			return View{}, err
		}
	}
	return out, nil
}

// buildView computes what a viewer sees of a share from the viewer's own grants
// on it (empty for the owner) and whether they manage it as the manager who
// created it (byCreator); ok is false when the viewer has no link to it.
// The full grant list is the caller's job (for canManage views only).
func buildView(sh sharingdb.Share, vaultName string, ownerID uuid.UUID, ownerName string, viewer uuid.UUID, mine []sharingdb.ShareGrant, byCreator bool) (View, bool) {
	out := View{Share: sh, VaultName: vaultName, OwnerID: ownerID, OwnerName: ownerName}
	if ownerID == viewer {
		out.IsOwner = true
		return out, true
	}
	if (len(mine) == 0 && !byCreator) || sh.RevokedAt != nil {
		return View{}, false
	}
	if byCreator {
		out.ByCreator = true
		out.MyPermission = max(best(mine), access.Manager)
		out.MyStatus = "accepted"
		return out, true
	}
	out.MyPermission = best(mine)
	out.MyStatus = myStatus(mine)
	if out.MyStatus == "pending" && out.MyPermission == access.None {
		// Not accepted yet: show the level that was offered.
		for _, g := range mine {
			if g.Status == "pending" {
				out.MyPermission = max(out.MyPermission, access.ParsePermission(g.Permission))
			}
		}
	}
	return out, true
}

// myStatus is the state of a viewer's invitation over all the grants that
// reach them (directly and through groups): accepted if any grant is, else
// pending if any still is, else declined.
func myStatus(grants []sharingdb.ShareGrant) string {
	status := ""
	for _, g := range grants {
		switch g.Status {
		case "accepted":
			return "accepted"
		case "pending":
			status = "pending"
		case "declined":
			if status == "" {
				status = "declined"
			}
		}
	}
	return status
}

// Get returns a share to its owner or to anyone invited to it.
func (s *Service) Get(ctx context.Context, viewer, shareID uuid.UUID) (View, error) {
	conn := s.db.Pool
	q := sharingdb.New(conn)
	sh, err := q.GetShare(ctx, shareID)
	if errors.Is(err, pgx.ErrNoRows) {
		return View{}, httpproblem.NotFound("share")
	}
	if err != nil {
		return View{}, err
	}
	return s.view(ctx, conn, sh, viewer)
}

// requireManage loads a share for a change made by its owner or a manager. An
// expired share gives nothing to anyone but the owner (§3.3.2): only the owner
// changes it, and so decides whether it comes back.
func (s *Service) requireManage(ctx context.Context, tx db.DBTX, actor, shareID uuid.UUID) (View, error) {
	q := sharingdb.New(tx)
	sh, err := q.GetShare(ctx, shareID)
	if errors.Is(err, pgx.ErrNoRows) {
		return View{}, httpproblem.NotFound("share")
	}
	if err != nil {
		return View{}, err
	}
	v, err := s.view(ctx, tx, sh, actor)
	if err != nil {
		return View{}, err
	}
	if sh.RevokedAt != nil || (!v.IsOwner && !live(sh, time.Now())) {
		return View{}, httpproblem.NotFound("share")
	}
	if !v.canManage() || v.MyStatus == "pending" {
		return View{}, httpproblem.Errorf(syncproto.CodeForbidden, "only the owner or a manager can change this share")
	}
	return v, nil
}

// UpdateInput changes a share; nil leaves a field alone.
type UpdateInput struct {
	DisplayName *string
	ExpiresAt   *time.Time
	ClearExpiry bool
}

// Update renames a share or changes its expiry (owner or manager).
func (s *Service) Update(ctx context.Context, actor, shareID uuid.UUID, in UpdateInput) (View, error) {
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		cur, err := s.requireManage(ctx, tx, actor, shareID)
		if err != nil {
			return err
		}
		name, expires := cur.Share.DisplayName, cur.Share.ExpiresAt
		if in.DisplayName != nil {
			if name, err = validName(*in.DisplayName); err != nil {
				return err
			}
		}
		if in.ClearExpiry {
			expires = nil
		} else if in.ExpiresAt != nil {
			if !in.ExpiresAt.After(time.Now()) {
				return httpproblem.Errorf(syncproto.CodeValidationFailed, "expires_at must be in the future")
			}
			expires = in.ExpiresAt
		}
		if _, err := sharingdb.New(tx).UpdateShare(ctx, sharingdb.UpdateShareParams{ID: shareID, DisplayName: name, ExpiresAt: expires}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "share.update", "share", shareID.String(), map[string]any{"name": name, "expires_at": expires}); err != nil {
			return err
		}
		return notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareUpdated, Share: shareID})
	})
	if err != nil {
		return View{}, err
	}
	return s.Get(ctx, actor, shareID)
}

// Revoke ends a share: recipients lose access at their next event or sync (owner only).
func (s *Service) Revoke(ctx context.Context, actor, shareID uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := sharingdb.New(tx)
		sh, err := q.GetShare(ctx, shareID)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpproblem.NotFound("share")
		}
		if err != nil {
			return err
		}
		v, err := vaults.GetVault(ctx, tx, sh.VaultID)
		if err != nil {
			return err
		}
		if v.OwnerID != actor {
			if _, verr := s.view(ctx, tx, sh, actor); verr != nil {
				return verr // invisible to the caller
			}
			return httpproblem.Errorf(syncproto.CodeForbidden, "only the owner of the vault can revoke a share")
		}
		n, err := q.RevokeShare(ctx, shareID)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpproblem.NotFound("share")
		}
		if err := audit.Record(ctx, tx, actor, "share.revoke", "share", shareID.String(), nil); err != nil {
			return err
		}
		if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareRevoked, Share: shareID}); err != nil {
			return err
		}
		// Its managers stop managing what they created inside it.
		return s.dropStaleCreatorGrants(ctx, tx, actor, v.ID)
	})
}

// PutGrant adds a grant or changes its level (owner or manager); a new grant is pending.
func (s *Service) PutGrant(ctx context.Context, actor, shareID uuid.UUID, g NewGrant) (sharingdb.ListGrantsRow, error) {
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		cur, err := s.requireManage(ctx, tx, actor, shareID)
		if err != nil {
			return err
		}
		v, err := vaults.GetVault(ctx, tx, cur.Share.VaultID)
		if err != nil {
			return err
		}
		if err := s.putGrant(ctx, tx, actor, v, shareID, g); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "grant.put", "share", shareID.String(), map[string]any{"principal_type": g.PrincipalType, "principal_id": g.PrincipalID, "permission": g.Permission.String()}); err != nil {
			return err
		}
		if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareGranted, Share: shareID}); err != nil {
			return err
		}
		// A manager grant lowered to editor or viewer takes the management with it.
		return s.dropStaleCreatorGrants(ctx, tx, actor, v.ID)
	})
	if err != nil {
		return sharingdb.ListGrantsRow{}, err
	}
	grants, err := sharingdb.New(s.db.Pool).ListGrants(ctx, shareID)
	if err != nil {
		return sharingdb.ListGrantsRow{}, err
	}
	for _, r := range grants {
		if r.PrincipalType == g.PrincipalType && r.PrincipalID == g.PrincipalID {
			return r, nil
		}
	}
	return sharingdb.ListGrantsRow{}, httpproblem.NotFound("grant")
}

// DeleteGrant removes a grant (owner or manager); whoever it reached is told.
func (s *Service) DeleteGrant(ctx context.Context, actor, shareID uuid.UUID, ptype string, pid uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := sharingdb.New(tx)
		cur, err := s.requireManage(ctx, tx, actor, shareID)
		if err != nil {
			return err
		}
		if !validPrincipal(ptype) {
			return httpproblem.Errorf(syncproto.CodeValidationFailed, "principal type must be user or group")
		}
		// Whoever the grant reached stops seeing the share: find them before it is gone.
		before, err := q.ListShareRecipients(ctx, shareID)
		if err != nil {
			return err
		}
		n, err := q.DeleteGrant(ctx, sharingdb.DeleteGrantParams{ShareID: shareID, PrincipalType: ptype, PrincipalID: pid})
		if err != nil {
			return err
		}
		if n == 0 {
			return httpproblem.NotFound("grant")
		}
		after, err := q.ListShareRecipients(ctx, shareID)
		if err != nil {
			return err
		}
		still := make(map[uuid.UUID]bool, len(after))
		for _, u := range after {
			still[u] = true
		}
		var lost []uuid.UUID
		for _, u := range before {
			if !still[u] {
				lost = append(lost, u)
			}
		}
		if err := audit.Record(ctx, tx, actor, "grant.delete", "share", shareID.String(), map[string]any{"principal_type": ptype, "principal_id": pid}); err != nil {
			return err
		}
		if len(lost) > 0 {
			if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareRevoked, Share: shareID, Users: lost}); err != nil {
				return err
			}
		}
		if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareUpdated, Share: shareID}); err != nil {
			return err
		}
		// A removed manager grant takes the management of the shares created through it.
		return s.dropStaleCreatorGrants(ctx, tx, actor, cur.Share.VaultID)
	})
}

// respond accepts or declines the invitation that reaches the caller.
func (s *Service) respond(ctx context.Context, userID, shareID uuid.UUID, accept bool) (View, error) {
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := sharingdb.New(tx)
		sh, err := q.GetShare(ctx, shareID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !live(sh, time.Now())) {
			return httpproblem.NotFound("share")
		}
		if err != nil {
			return err
		}
		grants, err := q.ListUserGrantsOnShare(ctx, sharingdb.ListUserGrantsOnShareParams{ShareID: shareID, PrincipalID: userID})
		if err != nil {
			return err
		}
		if len(grants) == 0 {
			return httpproblem.NotFound("share")
		}
		changed, declined := false, false
		for _, g := range grants {
			switch {
			case accept && g.Status != "accepted":
				// A group grant is accepted for the whole group by any of its members.
				if err := q.SetGrantStatus(ctx, sharingdb.SetGrantStatusParams{ID: g.ID, Status: "accepted"}); err != nil {
					return err
				}
				changed = true
			case !accept && g.PrincipalType == "user" && g.Status != "declined":
				if err := q.SetGrantStatus(ctx, sharingdb.SetGrantStatusParams{ID: g.ID, Status: "declined"}); err != nil {
					return err
				}
				changed = true
			case !accept && g.PrincipalType == "user":
				declined = true
			}
		}
		if !accept && !changed {
			if declined {
				// Declined already (a retried request): the answer stands.
				return nil
			}
			return httpproblem.Errorf(syncproto.CodeInvalidState, "an invitation sent to a group cannot be declined by one member")
		}
		action := "share.accept"
		if !accept {
			action = "share.decline"
		}
		if err := audit.Record(ctx, tx, userID, action, "share", shareID.String(), nil); err != nil {
			return err
		}
		if accept {
			return notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareGranted, Share: shareID, Users: []uuid.UUID{userID}})
		}
		// Declining an accepted manager grant gives up the management with it.
		return s.dropStaleCreatorGrants(ctx, tx, userID, sh.VaultID)
	})
	if err != nil {
		return View{}, err
	}
	return s.Get(ctx, userID, shareID)
}

// Accept accepts the invitation that reaches the caller.
func (s *Service) Accept(ctx context.Context, userID, shareID uuid.UUID) (View, error) {
	return s.respond(ctx, userID, shareID, true)
}

// Decline declines an invitation sent to the caller as a user.
func (s *Service) Decline(ctx context.Context, userID, shareID uuid.UUID) (View, error) {
	return s.respond(ctx, userID, shareID, false)
}

// shareRow is a share with what a list shows of its vault and owner.
type shareRow struct {
	share     sharingdb.Share
	vaultName string
	ownerID   uuid.UUID
	ownerName string
}

// views builds the views of many shares with a fixed number of queries (the
// viewer's grants and, for the shares they manage, every grant). Shares the
// viewer has no link to, or declined (keepDeclined false), are left out;
// database errors are returned, never mistaken for an empty list.
func (s *Service) views(ctx context.Context, tx db.DBTX, rows []shareRow, viewer uuid.UUID, keepDeclined bool) ([]View, error) {
	q := sharingdb.New(tx)
	ids := make([]uuid.UUID, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.share.ID)
	}
	if len(ids) == 0 {
		return []View{}, nil
	}
	mineRows, err := q.ListUserGrantsOnShares(ctx, sharingdb.ListUserGrantsOnSharesParams{ShareIds: ids, UserID: viewer})
	if err != nil {
		return nil, err
	}
	mine := map[uuid.UUID][]sharingdb.ShareGrant{}
	for _, g := range mineRows {
		mine[g.ShareID] = append(mine[g.ShareID], g)
	}
	byCreator, err := creatorManaged(ctx, tx, rows, viewer)
	if err != nil {
		return nil, err
	}
	out := make([]View, 0, len(rows))
	var managed []uuid.UUID
	for _, r := range rows {
		var grants []sharingdb.ShareGrant
		if r.ownerID != viewer {
			grants = mine[r.share.ID]
		}
		v, ok := buildView(r.share, r.vaultName, r.ownerID, r.ownerName, viewer, grants, byCreator[r.share.ID])
		if !ok || (!keepDeclined && v.MyStatus == "declined") {
			continue
		}
		if v.canManage() && v.MyStatus != "pending" {
			managed = append(managed, r.share.ID)
		}
		out = append(out, v)
	}
	if len(managed) > 0 {
		all, err := q.ListGrantsOfShares(ctx, managed)
		if err != nil {
			return nil, err
		}
		byShare := map[uuid.UUID][]sharingdb.ListGrantsRow{}
		for _, g := range all {
			byShare[g.ShareID] = append(byShare[g.ShareID], sharingdb.ListGrantsRow(g))
		}
		for i := range out {
			if out[i].canManage() && out[i].MyStatus != "pending" {
				out[i].Grants = byShare[out[i].Share.ID]
			}
		}
	}
	return out, nil
}

// The lists of shares, which tag their cursors (pagination.Key.List).
const (
	ownedList    = "shares-owned"
	receivedList = "shares-received"
	mountsList   = "shares-mounts"
)

// beforeID reads the cursor of a list of shares: the id of the last share of
// the previous page (nil for the first page).
func beforeID(list, cursor string) (*uuid.UUID, error) {
	after, err := pagination.Decode(list, cursor)
	if err != nil || after == nil {
		return nil, err
	}
	return &after.ID, nil
}

// nextAfter is the cursor of the page after the share last, or nil on the
// last page. It is the last share the query returned, not the last one
// listed: views leaves some out, and the next page starts after them.
func nextAfter(list string, more bool, last uuid.UUID) *string {
	if !more {
		return nil
	}
	return pagination.Cursor(pagination.Key{List: list, ID: last})
}

// ListOwned returns a page of at most limit shares, newest first, after
// cursor ("" for the first page), of the vaults the caller owns plus those
// they manage, by grant or as the manager who created them (ADR-0041 §8), and
// the cursor of the next page (nil on the last). A page can list fewer shares
// than limit, even none, and still have a next one.
func (s *Service) ListOwned(ctx context.Context, userID uuid.UUID, limit int, cursor string) ([]View, *string, error) {
	before, err := beforeID(ownedList, cursor)
	if err != nil {
		return nil, nil, err
	}
	conn := s.db.Pool
	rows, err := sharingdb.New(conn).ListSharesOfVaultOwner(ctx, sharingdb.ListSharesOfVaultOwnerParams{
		UserID: userID, BeforeID: before, MaxRows: pagination.FetchLimit(limit),
	})
	if err != nil {
		return nil, nil, err
	}
	rows, more := pagination.Trim(rows, limit)
	list := make([]shareRow, 0, len(rows))
	for _, r := range rows {
		list = append(list, shareRow{share: r.Share, vaultName: r.VaultName, ownerID: r.OwnerID, ownerName: r.OwnerName})
	}
	vs, err := s.views(ctx, conn, list, userID, true)
	if err != nil || len(rows) == 0 {
		return vs, nil, err
	}
	return vs, nextAfter(ownedList, more, rows[len(rows)-1].Share.ID), nil
}

// ListReceived returns a page of the shares that reach the caller, pending
// invitations included, as ListOwned pages its shares.
func (s *Service) ListReceived(ctx context.Context, userID uuid.UUID, limit int, cursor string) ([]View, *string, error) {
	before, err := beforeID(receivedList, cursor)
	if err != nil {
		return nil, nil, err
	}
	conn := s.db.Pool
	rows, err := s.receivedPage(ctx, conn, userID, false, before, limit)
	if err != nil {
		return nil, nil, err
	}
	rows, more := pagination.Trim(rows, limit)
	list := make([]shareRow, 0, len(rows))
	for _, r := range rows {
		list = append(list, shareRow{share: r.Share, vaultName: r.VaultName, ownerID: r.OwnerID, ownerName: r.OwnerName})
	}
	vs, err := s.views(ctx, conn, list, userID, false)
	if err != nil || len(rows) == 0 {
		return vs, nil, err
	}
	return vs, nextAfter(receivedList, more, rows[len(rows)-1].Share.ID), nil
}

// receivedPage runs ListReceivedShares: limit+1 shares that reach userID
// (only the accepted ones with acceptedOnly), newest first, before before.
func (s *Service) receivedPage(ctx context.Context, conn db.DBTX, userID uuid.UUID, acceptedOnly bool, before *uuid.UUID, limit int) ([]sharingdb.ListReceivedSharesRow, error) {
	return sharingdb.New(conn).ListReceivedShares(ctx, sharingdb.ListReceivedSharesParams{
		UserID: userID, AcceptedOnly: acceptedOnly, BeforeID: before, MaxRows: pagination.FetchLimit(limit),
	})
}

// Mount is an accepted share ready to be synced.
type Mount struct {
	ShareID      uuid.UUID
	VaultID      uuid.UUID
	DisplayName  string
	ResourceType string
	Permission   access.Permission
	OwnerName    string
	ExpiresAt    *time.Time
}

// Scope is the value of the scope parameter that syncs the mount.
func (m Mount) Scope() string { return access.ScopePrefix + m.ShareID.String() }

// SharedWithMe returns a page of at most limit accepted shares of the caller,
// newest first, after cursor ("" for the first page), each with the strongest
// level the caller holds on it, and the cursor of the next page (nil on the
// last), as ListOwned pages its shares.
func (s *Service) SharedWithMe(ctx context.Context, userID uuid.UUID, limit int, cursor string) ([]Mount, *string, error) {
	before, err := beforeID(mountsList, cursor)
	if err != nil {
		return nil, nil, err
	}
	conn := s.db.Pool
	rows, err := s.receivedPage(ctx, conn, userID, true, before, limit)
	if err != nil {
		return nil, nil, err
	}
	rows, more := pagination.Trim(rows, limit)
	if len(rows) == 0 {
		return []Mount{}, nil, nil
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.Share.ID)
	}
	grants, err := sharingdb.New(conn).ListUserGrantsOnShares(ctx, sharingdb.ListUserGrantsOnSharesParams{ShareIds: ids, UserID: userID})
	if err != nil {
		return nil, nil, err
	}
	level := make(map[uuid.UUID]access.Permission, len(rows))
	for _, g := range grants {
		if g.Status == "accepted" {
			level[g.ShareID] = max(level[g.ShareID], access.ParsePermission(g.Permission))
		}
	}
	out := make([]Mount, 0, len(rows))
	for _, r := range rows {
		p, ok := level[r.Share.ID]
		if !ok { // declined or removed since the page was read
			continue
		}
		sh := r.Share
		out = append(out, Mount{
			ShareID: sh.ID, VaultID: sh.VaultID, DisplayName: sh.DisplayName, ResourceType: sh.ResourceType,
			Permission: p, OwnerName: r.OwnerName, ExpiresAt: sh.ExpiresAt,
		})
	}
	return out, nextAfter(mountsList, more, rows[len(rows)-1].Share.ID), nil
}
