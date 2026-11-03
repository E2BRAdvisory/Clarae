// Package privacy implements the GDPR rights that Specifications.md §3.5 does not
// cover (ADR-0021): export of the account data (art. 15/20) and account deletion
// (art. 17). Deletion anonymises the user row at once and soft-deletes the vaults;
// the worker (jobs.PurgeDeletedAccounts) removes what is left after the retention.
package privacy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/groups"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/keycloak"
	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/privacy/privacydb"
	"memobrain/services/cloud/internal/sharing"
	"memobrain/services/cloud/internal/users"
	"memobrain/services/cloud/internal/vaults"
	"memobrain/shared/syncproto"
)

// SessionInvalidator drops the cached authentication state of a user (auth.Middleware).
type SessionInvalidator interface{ Invalidate(subject string) }

// Service implements the privacy module.
type Service struct {
	db  *db.DB
	kc  keycloak.Admin
	inv SessionInvalidator
	now func() time.Time
}

// NewService wires the module; inv may be nil.
func NewService(d *db.DB, kc keycloak.Admin, inv SessionInvalidator) *Service {
	return &Service{db: d, kc: kc, inv: inv, now: time.Now}
}

// Notice is embedded in every export to explain what it does not contain.
const Notice = "Vault content is not part of this file. Private vaults are end-to-end encrypted: " +
	"the server only stores ciphertext it cannot read, so only your devices can export them. " +
	"Shared vaults can be downloaded as a ZIP from the vault export function."

// Export is the JSON document returned by GET /me/export, except its last
// member, audit_log: the entries about a user can be many, so EachAuditEntry
// reads them page by page while the response is written.
type Export struct {
	GeneratedAt    time.Time        `json:"generated_at"`
	Notice         string           `json:"notice"`
	Profile        map[string]any   `json:"profile"`
	Devices        []map[string]any `json:"devices"`
	Groups         []map[string]any `json:"groups"`
	Vaults         []map[string]any `json:"vaults"`
	Shares         []map[string]any `json:"shares"`
	ReceivedGrants []map[string]any `json:"received_grants"`
}

// auditPage is how many audit entries EachAuditEntry reads per query.
const auditPage = 1000

// EachAuditEntry calls fn with every audit entry about a user (as actor or
// as target), oldest first, reading them page by page: the export is
// complete however long the trail is, without holding it in memory.
func (s *Service) EachAuditEntry(ctx context.Context, userID uuid.UUID, fn func(map[string]any) error) error {
	q := privacydb.New(s.db.Pool)
	var after int64
	for {
		entries, err := q.ListAuditAboutUser(ctx, privacydb.ListAuditAboutUserParams{UserID: userID, AfterID: after, PageSize: auditPage})
		if err != nil {
			return err
		}
		for _, a := range entries {
			var details any
			if len(a.Details) > 0 {
				_ = json.Unmarshal(a.Details, &details)
			}
			if err := fn(map[string]any{
				"id": a.ID, "at": a.At, "actor_id": a.ActorID, "action": a.Action,
				"target_type": a.TargetType, "target_id": a.TargetID, "details": details,
			}); err != nil {
				return err
			}
			after = a.ID
		}
		if len(entries) < auditPage {
			return nil
		}
	}
}

// Export collects the account data of a user but the audit log (see
// EachAuditEntry).
func (s *Service) Export(ctx context.Context, userID uuid.UUID) (Export, error) {
	conn := s.db.Pool
	q := privacydb.New(conn)
	u, err := users.GetUserByID(ctx, conn, userID)
	if err != nil {
		return Export{}, err
	}
	out := Export{
		GeneratedAt: s.now().UTC(),
		Notice:      Notice,
		Profile: map[string]any{
			"id": u.ID, "username": u.Username, "email": u.Email, "display_name": u.DisplayName,
			"role": u.Role, "status": u.Status, "quota_bytes_override": u.QuotaBytesOverride,
			"used_bytes": u.UsedBytes, "created_at": u.CreatedAt, "last_login_at": u.LastLoginAt,
		},
		Devices: []map[string]any{}, Groups: []map[string]any{}, Vaults: []map[string]any{},
		Shares: []map[string]any{}, ReceivedGrants: []map[string]any{},
	}

	devices, err := q.ListAllDevicesOfUser(ctx, userID)
	if err != nil {
		return Export{}, err
	}
	for _, d := range devices {
		out.Devices = append(out.Devices, map[string]any{
			"id": d.ID, "name": d.Name, "platform": d.Platform, "app_version": d.AppVersion,
			"created_at": d.CreatedAt, "last_seen_at": d.LastSeenAt, "revoked_at": d.RevokedAt,
		})
	}
	memberships, err := groups.ListGroupsOfUser(ctx, conn, userID)
	if err != nil {
		return Export{}, err
	}
	for _, g := range memberships {
		out.Groups = append(out.Groups, map[string]any{"id": g.ID, "name": g.Name, "description": g.Description, "member_role": g.MemberRole})
	}
	envelopes, err := q.ListEnvelopeKindsOfOwner(ctx, userID)
	if err != nil {
		return Export{}, err
	}
	vaults, err := q.ListVaultsOfOwnerExport(ctx, userID)
	if err != nil {
		return Export{}, err
	}
	for _, v := range vaults {
		kinds := []string{}
		for _, e := range envelopes {
			if e.VaultID == v.ID {
				kinds = append(kinds, e.Kind)
			}
		}
		out.Vaults = append(out.Vaults, map[string]any{
			"id": v.ID, "name": v.Name, "kind": v.Kind, "total_bytes": v.TotalBytes, "file_count": v.FileCount,
			"created_at": v.CreatedAt, "deleted_at": v.DeletedAt, "key_envelopes": kinds,
		})
	}
	shares, err := q.ListSharesOfUserExport(ctx, userID)
	if err != nil {
		return Export{}, err
	}
	owned := make(map[uuid.UUID]bool, len(vaults))
	for _, v := range vaults {
		owned[v.ID] = true
	}
	for _, sh := range shares {
		entry := map[string]any{
			"id": sh.ID, "vault_id": sh.VaultID, "vault_name": sh.VaultName, "resource_type": sh.ResourceType,
			"path_prefix": sh.PathPrefix, "display_name": sh.DisplayName, "created_by": sh.CreatedBy,
			"created_at": sh.CreatedAt, "expires_at": sh.ExpiresAt, "revoked_at": sh.RevokedAt,
		}
		// The recipients of a share are the owner's data, and the manager who
		// created it sees them only while still managing it (ADR-0041 §8), as
		// the share itself shows them: otherwise the export says only that the
		// user created it.
		show := owned[sh.VaultID]
		if !show {
			if show, err = sharing.SeesGrants(ctx, conn, sh.ID, userID); err != nil {
				return Export{}, err
			}
		}
		if show {
			grants, err := sharing.ListGrants(ctx, conn, sh.ID)
			if err != nil {
				return Export{}, err
			}
			gs := make([]map[string]any, 0, len(grants))
			for _, g := range grants {
				gs = append(gs, map[string]any{
					"principal_type": g.PrincipalType, "principal_id": g.PrincipalID, "principal_name": g.PrincipalName,
					"permission": g.Permission, "status": g.Status, "granted_by": g.GrantedBy, "created_at": g.CreatedAt,
				})
			}
			entry["grants"] = gs
		}
		out.Shares = append(out.Shares, entry)
	}
	received, err := sharing.ListGrantsOfUser(ctx, conn, userID)
	if err != nil {
		return Export{}, err
	}
	for _, g := range received {
		out.ReceivedGrants = append(out.ReceivedGrants, map[string]any{
			"share_id": g.ShareID, "vault_id": g.VaultID, "vault_name": g.VaultName, "owner": g.OwnerName,
			"resource_type": g.ResourceType, "path_prefix": g.PathPrefix, "display_name": g.DisplayName,
			"permission": g.Permission, "status": g.Status, "granted_by": g.GrantedBy, "created_at": g.CreatedAt,
			"expires_at": g.ExpiresAt,
		})
	}
	// Record that the export happened; the audit log, streamed after the
	// rest by EachAuditEntry, already includes this entry.
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		return audit.Record(ctx, tx, userID, "account.export", "user", userID.String(), nil)
	})
	return out, err
}

// DeleteRequest is the confirmation the caller must give.
type DeleteRequest struct {
	Confirm             string
	AcknowledgeDataLoss bool
}

// Delete deletes the caller's account: see the package comment.
func (s *Service) Delete(ctx context.Context, userID uuid.UUID, req DeleteRequest) error {
	var res Deletion
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		res, err = DeleteAccount(ctx, tx, userID, func(cur users.User, private int) error {
			if req.Confirm != cur.Username {
				return httpproblem.Errorf(syncproto.CodeValidationFailed, "confirm must equal your username")
			}
			if private > 0 && !req.AcknowledgeDataLoss {
				return httpproblem.Errorf(syncproto.CodeValidationFailed,
					"you own %d private (end-to-end encrypted) vault(s): their content cannot be recovered by anyone once deleted; set acknowledge_data_loss to confirm", private)
			}
			return nil
		})
		if err != nil {
			return err
		}
		// Written after the anonymisation: it must not bring the address back.
		return audit.Record(audit.WithoutClientIP(ctx), tx, userID, "account.delete", "user", userID.String(), map[string]any{
			"vaults": res.Vaults, "private_vaults": res.PrivateVaults, "memberships": res.Memberships, "reattributed_grants": res.ReattributedGrants,
		})
	})
	if err != nil {
		return err
	}
	if s.inv != nil {
		s.inv.Invalidate(res.Subject)
	}
	if err := s.kc.SetEnabled(ctx, res.Subject, false); err != nil && !errors.Is(err, keycloak.ErrDisabled) && !errors.Is(err, keycloak.ErrNotFound) {
		// The account is already deleted and unusable here; the operator can disable it in Keycloak.
		return fmt.Errorf("account deleted but the identity provider could not be updated: %w", err)
	}
	return nil
}

// Deletion reports what DeleteAccount did.
type Deletion struct {
	// Subject is the identity provider subject of the account, which the
	// caller disables there and drops from the authentication cache.
	Subject            string
	Vaults             int64
	PrivateVaults      int
	Memberships        int64
	ReattributedGrants int
}

// DeleteAccount deletes an account inside tx: the one implementation behind
// both self-deletion (DELETE /me, GDPR art. 17) and deletion by an
// administrator (DELETE /admin/users/{id}), so the two cannot drift apart.
//
// check runs once the account is loaded and locked, with the number of live
// private vaults it owns; an error from it aborts the deletion. The last
// active administrator cannot be deleted.
//
// Lock order: the account's vault rows first, then user rows. A commit locks
// its vault row and then the owner's row (usage), so taking them the other
// way round would deadlock against a commit in one of the account's vaults.
//
// The account row is anonymised at once, the vaults enter the retention
// period (the purge job removes them afterwards), memberships, received
// grants and ready exports are removed, pending uploads expire (the uploads
// job deletes them with their chunks), and the grants the
// account gave as a manager on other owners' vaults are re-attributed to the
// vault owner, so their recipients keep access (ADR-0041); each such share is
// audited and notified as updated. The caller records its own audit entry
// and publishes nothing else.
func DeleteAccount(ctx context.Context, tx pgx.Tx, userID uuid.UUID, check func(cur users.User, privateVaults int) error) (Deletion, error) {
	q := privacydb.New(tx)
	ids, err := vaults.ListVaultIDsOfOwner(ctx, tx, userID)
	if err != nil {
		return Deletion{}, err
	}
	for _, id := range ids {
		if err := vaults.LockVault(ctx, tx, id); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Deletion{}, err
		}
	}
	cur, err := users.GetUserByID(ctx, tx, userID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cur.Status == "deleted") {
		return Deletion{}, httpproblem.NotFound("user")
	}
	if err != nil {
		return Deletion{}, err
	}
	if cur.Role == "admin" {
		// Locks every active administrator so two removals cannot both pass.
		n, err := users.LockActiveAdmins(ctx, tx)
		if err != nil {
			return Deletion{}, err
		}
		// Read again under the lock: a concurrent change may have committed.
		if cur, err = users.GetUserByID(ctx, tx, userID); err != nil {
			return Deletion{}, err
		}
		if cur.Role == "admin" && cur.Status == "active" && n <= 1 {
			return Deletion{}, httpproblem.Errorf(syncproto.CodeInvalidState, "this is the last active administrator: promote another administrator first")
		}
	}
	private, err := q.CountLivePrivateVaultsOfOwner(ctx, userID)
	if err != nil {
		return Deletion{}, err
	}
	if check != nil {
		if err := check(cur, int(private)); err != nil {
			return Deletion{}, err
		}
	}
	res := Deletion{Subject: cur.KeycloakSub, PrivateVaults: int(private)}
	if res.Vaults, err = vaults.SoftDeleteVaultsOfOwner(ctx, tx, userID); err != nil {
		return Deletion{}, err
	}
	if err := Anonymise(ctx, tx, userID); err != nil {
		return Deletion{}, err
	}
	if res.Memberships, err = q.DeleteMembershipsOfUser(ctx, userID); err != nil {
		return Deletion{}, err
	}
	if err := sharing.DeleteGrantsOfPrincipal(ctx, tx, "user", userID); err != nil {
		return Deletion{}, err
	}
	moved, err := q.ReattributeForeignGrants(ctx, userID)
	if err != nil {
		return Deletion{}, err
	}
	res.ReattributedGrants = len(moved)
	perShare := map[uuid.UUID]uuid.UUID{}
	for _, m := range moved {
		perShare[m.ShareID] = m.OwnerID
	}
	for share, owner := range perShare {
		if err := audit.Record(audit.WithoutClientIP(ctx), tx, userID, "share.grants_reattributed", "share", share.String(),
			map[string]any{"from": userID, "to": owner}); err != nil {
			return Deletion{}, err
		}
		if err := notify.PublishShare(ctx, tx, notify.ShareEvent{Kind: notify.ShareUpdated, Share: share}); err != nil {
			return Deletion{}, err
		}
	}
	if _, err := q.DeleteGrantsGrantedBy(ctx, userID); err != nil {
		return Deletion{}, err
	}
	// Expired rather than deleted: the uploads job removes each one with its
	// chunk objects, which this transaction cannot reach.
	if _, err := q.ExpireUploadsOfUser(ctx, userID); err != nil {
		return Deletion{}, err
	}
	if _, err := q.ExpireExportsOfUser(ctx, userID); err != nil {
		return Deletion{}, err
	}
	if err := notify.PublishAccount(ctx, tx, notify.AccountEvent{User: userID, Kind: notify.AccountSuspended}); err != nil {
		return Deletion{}, err
	}
	return res, nil
}

// Anonymise replaces the personal data of a user with a tombstone and removes
// the devices and the network addresses in the audit trail. It keeps ids so
// audit rows and revisions stay consistent, and it is idempotent.
func Anonymise(ctx context.Context, tx db.DBTX, id uuid.UUID) error {
	q := privacydb.New(tx)
	if _, err := q.TombstoneUser(ctx, id); err != nil {
		return err
	}
	if _, err := q.DeleteDevicesOfUser(ctx, id); err != nil {
		return err
	}
	if err := q.RevokeDevicesOfUser(ctx, id); err != nil {
		return err
	}
	_, err := q.AnonymiseAuditOfUser(ctx, &id)
	return err
}
