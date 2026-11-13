// Package sharing implements shares, grants and the permission evaluator
// (§2.6.4, §3.3.2): who may do what on a vault, a folder or a document, and the
// invitation workflow. Enforcement happens in the modules that serve content,
// through the access.Authorizer this package provides.
package sharing

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"clarae/services/cloud/internal/access"
	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/httpproblem"
	"clarae/services/cloud/internal/sharing/sharingdb"
	"clarae/services/cloud/internal/vaults"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

// Service implements the sharing module.
type Service struct{ db *db.DB }

// NewService wires the module.
func NewService(d *db.DB) *Service { return &Service{db: d} }

var _ access.Authorizer = (*Service)(nil)

// best returns the highest level among accepted grants.
func best(grants []sharingdb.ShareGrant) access.Permission {
	var p access.Permission
	for _, g := range grants {
		if g.Status == "accepted" {
			p = max(p, access.ParsePermission(g.Permission))
		}
	}
	return p
}

// live reports whether a share still grants anything.
func live(s sharingdb.Share, now time.Time) bool {
	return s.RevokedAt == nil && (s.ExpiresAt == nil || s.ExpiresAt.After(now))
}

// Authorize implements access.Authorizer.
func (s *Service) Authorize(ctx context.Context, userID, vaultID uuid.UUID, scope string, need access.Permission) (access.Access, error) {
	conn := s.db.Pool
	q := sharingdb.New(conn)
	v, err := vaults.GetVault(ctx, conn, vaultID)
	if errors.Is(err, pgx.ErrNoRows) {
		return access.Access{}, httpproblem.NotFound("vault")
	}
	if err != nil {
		return access.Access{}, err
	}
	if v.DeletedAt != nil {
		return access.Access{}, httpproblem.NotFound("vault")
	}
	if scope == "" {
		if v.OwnerID != userID {
			return access.Access{}, httpproblem.NotFound("vault")
		}
		return access.Access{Vault: v, Perm: access.Owner}, nil
	}
	sid, ok := access.ParseScope(scope)
	if !ok {
		return access.Access{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "scope must be share:<id>")
	}
	sh, err := q.GetShare(ctx, sid)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (sh.VaultID != vaultID || !live(sh, time.Now()))) {
		return access.Access{}, httpproblem.NotFound("share")
	}
	if err != nil {
		return access.Access{}, err
	}
	perm := access.Owner
	if v.OwnerID != userID {
		grants, err := q.ListUserGrantsOnShare(ctx, sharingdb.ListUserGrantsOnShareParams{ShareID: sid, PrincipalID: userID})
		if err != nil {
			return access.Access{}, err
		}
		if perm = best(grants); perm == access.None {
			return access.Access{}, httpproblem.NotFound("share")
		}
	}
	if perm < need {
		return access.Access{}, httpproblem.Errorf(syncproto.CodeForbidden, "this share is %s: %s access is required", perm, need)
	}
	return access.Access{Vault: v, Perm: perm, Scope: access.NewScope(sh.ID, sh.ResourceType, sh.PathPrefix, sh.FileID)}, nil
}

// Evaluator answers "what may this user do on this path" for one request: the
// grants of the user are loaded once and reused (§3.3.2: cached per request).
type Evaluator struct {
	svc    *Service
	userID uuid.UUID
	grants []sharingdb.ListGrantsOfUserRow
	loaded bool
}

// Evaluator returns a per-request evaluator for a user.
func (s *Service) Evaluator(userID uuid.UUID) *Evaluator { return &Evaluator{svc: s, userID: userID} }

// Effective is the algorithm of §3.3.2 for (user, vault, path): private vaults admit
// only their owner; the owner is owner; otherwise the maximum over the accepted
// grants of the user and of their groups on live shares whose scope covers the path.
func (e *Evaluator) Effective(ctx context.Context, vault vaults.Vault, path string) (access.Permission, error) {
	if vault.Kind == "private" {
		if vault.OwnerID == e.userID {
			return access.Owner, nil
		}
		return access.None, nil
	}
	if vault.OwnerID == e.userID {
		return access.Owner, nil
	}
	if !e.loaded {
		g, err := sharingdb.New(e.svc.db.Pool).ListGrantsOfUser(ctx, e.userID)
		if err != nil {
			return access.None, err
		}
		e.grants, e.loaded = g, true
	}
	var fileID uuid.UUID
	var fileLooked bool
	var perm access.Permission
	for _, g := range e.grants {
		if g.VaultID != vault.ID || g.Status != "accepted" {
			continue
		}
		sc := access.NewScope(g.ShareID, g.ResourceType, g.PathPrefix, g.FileID)
		covered := false
		switch g.ResourceType {
		case access.ResourceFile:
			if !fileLooked {
				fileLooked = true
				id, err := sharingdb.New(e.svc.db.Pool).PathKeyTaken(ctx, sharingdb.PathKeyTakenParams{VaultID: vault.ID, PathKey: pathrules.Key(path)})
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return access.None, err
				}
				fileID = id
			}
			covered = fileID != uuid.Nil && sc.ContainsFile(fileID, path)
		default:
			covered = sc.ContainsPath(path)
		}
		if covered {
			perm = max(perm, access.ParsePermission(g.Permission))
		}
	}
	return perm, nil
}
