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
	"memobrain/services/cloud/internal/db/dbgen"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/keycloak"
	"memobrain/services/cloud/internal/notify"
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

// Export is the JSON document returned by GET /me/export.
type Export struct {
	GeneratedAt    time.Time        `json:"generated_at"`
	Notice         string           `json:"notice"`
	Profile        map[string]any   `json:"profile"`
	Devices        []map[string]any `json:"devices"`
	Groups         []map[string]any `json:"groups"`
	Vaults         []map[string]any `json:"vaults"`
	Shares         []map[string]any `json:"shares"`
	ReceivedGrants []map[string]any `json:"received_grants"`
	AuditLog       []map[string]any `json:"audit_log"`
}

// Export collects the account data of a user.
func (s *Service) Export(ctx context.Context, userID uuid.UUID) (Export, error) {
	q := s.db.Queries()
	u, err := q.GetUserByID(ctx, userID)
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
		Shares: []map[string]any{}, ReceivedGrants: []map[string]any{}, AuditLog: []map[string]any{},
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
	groups, err := q.ListGroupsOfUser(ctx, userID)
	if err != nil {
		return Export{}, err
	}
	for _, g := range groups {
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
	for _, sh := range shares {
		grants, err := q.ListGrants(ctx, sh.ID)
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
		out.Shares = append(out.Shares, map[string]any{
			"id": sh.ID, "vault_id": sh.VaultID, "vault_name": sh.VaultName, "resource_type": sh.ResourceType,
			"path_prefix": sh.PathPrefix, "display_name": sh.DisplayName, "created_by": sh.CreatedBy,
			"created_at": sh.CreatedAt, "expires_at": sh.ExpiresAt, "revoked_at": sh.RevokedAt, "grants": gs,
		})
	}
	received, err := q.ListGrantsOfUser(ctx, userID)
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
	entries, err := q.ListAuditAboutUser(ctx, &userID)
	if err != nil {
		return Export{}, err
	}
	for _, a := range entries {
		var details any
		if len(a.Details) > 0 {
			_ = json.Unmarshal(a.Details, &details)
		}
		out.AuditLog = append(out.AuditLog, map[string]any{
			"id": a.ID, "at": a.At, "actor_id": a.ActorID, "action": a.Action,
			"target_type": a.TargetType, "target_id": a.TargetID, "details": details,
		})
	}
	// Record that the export happened (the entry shows up in the next export).
	err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
		return audit.Record(ctx, q, userID, "account.export", "user", userID.String(), nil)
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
	var sub string
	err := s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		cur, err := q.GetUserByID(ctx, userID)
		if err != nil {
			return err
		}
		if cur.Status == "deleted" {
			return httpproblem.NotFound("user")
		}
		if req.Confirm != cur.Username {
			return httpproblem.Errorf(syncproto.CodeValidationFailed, "confirm must equal your username")
		}
		if cur.Role == "admin" && cur.Status == "active" {
			// Lock every active admin so two administrators cannot delete themselves concurrently.
			if _, err := q.LockActiveAdmins(ctx); err != nil {
				return err
			}
			n, err := q.CountActiveAdmins(ctx)
			if err != nil {
				return err
			}
			if n <= 1 {
				return httpproblem.Errorf(syncproto.CodeInvalidState, "this is the last active administrator: promote another administrator first")
			}
		}
		private, err := q.CountLivePrivateVaultsOfOwner(ctx, userID)
		if err != nil {
			return err
		}
		if private > 0 && !req.AcknowledgeDataLoss {
			return httpproblem.Errorf(syncproto.CodeValidationFailed,
				"you own %d private (end-to-end encrypted) vault(s): their content cannot be recovered by anyone once deleted; set acknowledge_data_loss to confirm", private)
		}
		sub = cur.KeycloakSub
		vaults, err := q.SoftDeleteVaultsOfOwner(ctx, userID)
		if err != nil {
			return err
		}
		if err := Anonymise(ctx, q, userID); err != nil {
			return err
		}
		memberships, err := q.DeleteMembershipsOfUser(ctx, userID)
		if err != nil {
			return err
		}
		if _, err := q.DeleteGrantsOfPrincipal(ctx, dbgen.DeleteGrantsOfPrincipalParams{PrincipalType: "user", PrincipalID: userID}); err != nil {
			return err
		}
		if _, err := q.DeleteGrantsGrantedBy(ctx, userID); err != nil {
			return err
		}
		if _, err := q.DeleteUploadsOfUser(ctx, userID); err != nil {
			return err
		}
		if _, err := q.ExpireExportsOfUser(ctx, userID); err != nil {
			return err
		}
		if err := audit.Record(ctx, q, userID, "account.delete", "user", userID.String(), map[string]any{
			"vaults": vaults, "private_vaults": private, "memberships": memberships,
		}); err != nil {
			return err
		}
		return notify.PublishAccount(ctx, tx, notify.AccountEvent{User: userID, Kind: notify.AccountSuspended})
	})
	if err != nil {
		return err
	}
	if s.inv != nil {
		s.inv.Invalidate(sub)
	}
	if err := s.kc.SetEnabled(ctx, sub, false); err != nil && !errors.Is(err, keycloak.ErrDisabled) && !errors.Is(err, keycloak.ErrNotFound) {
		// The account is already deleted and unusable here; the operator can disable it in Keycloak.
		return fmt.Errorf("account deleted but the identity provider could not be updated: %w", err)
	}
	return nil
}

// Anonymise replaces the personal data of a user with a tombstone and removes
// the devices and the network addresses in the audit trail. It keeps ids so
// audit rows and revisions stay consistent, and it is idempotent.
func Anonymise(ctx context.Context, q *dbgen.Queries, id uuid.UUID) error {
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
