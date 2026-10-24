// Package groups manages application groups (§2.6.5, D-05): entities of the cloud
// database, independent of Keycloak, with the roles member and manager. M4 offers
// the internal service API, the caller's own memberships and the directory used to
// pick share recipients; the admin endpoints arrive with M5.
package groups

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"nodus/services/cloud/internal/audit"
	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/db/dbgen"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
)

// DirectoryLimit caps the answers of the directory endpoints.
const DirectoryLimit = 20

// ConfigNotifier is told when memberships change, because the effective
// configuration of the affected users may change with them.
type ConfigNotifier interface {
	Changed(ctx context.Context, tx pgx.Tx) error
}

// Service implements the groups module.
type Service struct {
	db     *db.DB
	config ConfigNotifier
}

// NewService wires the module; config may be nil in unit tests.
func NewService(d *db.DB, config ConfigNotifier) *Service { return &Service{db: d, config: config} }

// Member roles inside a group.
const (
	RoleMember  = "member"
	RoleManager = "manager"
)

func validName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" || len([]rune(n)) > 100 {
		return "", httpproblem.Errorf(syncproto.CodeValidationFailed, "a group name has 1..100 characters")
	}
	return n, nil
}

func nameTaken(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

// Create adds a group.
func (s *Service) Create(ctx context.Context, actor uuid.UUID, name, description string) (dbgen.Group, error) {
	n, err := validName(name)
	if err != nil {
		return dbgen.Group{}, err
	}
	var desc *string
	if description != "" {
		desc = &description
	}
	var g dbgen.Group
	err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
		var err error
		if g, err = q.CreateGroup(ctx, dbgen.CreateGroupParams{ID: uuid.Must(uuid.NewV7()), Name: n, Description: desc}); err != nil {
			return err
		}
		return audit.Record(ctx, q, actor, "group.create", "group", g.ID.String(), map[string]string{"name": n})
	})
	if nameTaken(err) {
		return dbgen.Group{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a group named %q exists", n)
	}
	return g, err
}

// Get returns a group.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (dbgen.Group, error) {
	g, err := s.db.Queries().GetGroup(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return dbgen.Group{}, httpproblem.NotFound("group")
	}
	return g, err
}

// List returns every group.
func (s *Service) List(ctx context.Context) ([]dbgen.Group, error) {
	return s.db.Queries().ListGroups(ctx)
}

// Update renames a group or changes its description.
func (s *Service) Update(ctx context.Context, actor, id uuid.UUID, name, description string) (dbgen.Group, error) {
	n, err := validName(name)
	if err != nil {
		return dbgen.Group{}, err
	}
	var desc *string
	if description != "" {
		desc = &description
	}
	var g dbgen.Group
	err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
		var err error
		if g, err = q.UpdateGroup(ctx, dbgen.UpdateGroupParams{ID: id, Name: n, Description: desc}); err != nil {
			return err
		}
		return audit.Record(ctx, q, actor, "group.update", "group", id.String(), map[string]string{"name": n})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return dbgen.Group{}, httpproblem.NotFound("group")
	}
	if nameTaken(err) {
		return dbgen.Group{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a group named %q exists", n)
	}
	return g, err
}

// Delete removes a group; its memberships, grants to it and profile assignments go with it.
func (s *Service) Delete(ctx context.Context, actor, id uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		n, err := q.DeleteGroup(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpproblem.NotFound("group")
		}
		// Grants to the group are rows of share_grants keyed by (type, id) without a
		// foreign key: remove them so no dangling principal keeps a share alive.
		if _, err := q.DeleteGrantsOfPrincipal(ctx, dbgen.DeleteGrantsOfPrincipalParams{PrincipalType: "group", PrincipalID: id}); err != nil {
			return err
		}
		if err := audit.Record(ctx, q, actor, "group.delete", "group", id.String(), nil); err != nil {
			return err
		}
		return s.touchConfig(ctx, tx)
	})
}

func (s *Service) touchConfig(ctx context.Context, tx pgx.Tx) error {
	if s.config == nil {
		return nil
	}
	return s.config.Changed(ctx, tx)
}

// SetMember adds a user to a group or changes their role.
func (s *Service) SetMember(ctx context.Context, actor, groupID, userID uuid.UUID, role string) error {
	if role != RoleMember && role != RoleManager {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "role must be member or manager")
	}
	return s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		if _, err := q.GetGroup(ctx, groupID); errors.Is(err, pgx.ErrNoRows) {
			return httpproblem.NotFound("group")
		} else if err != nil {
			return err
		}
		if u, err := q.GetUserBrief(ctx, userID); errors.Is(err, pgx.ErrNoRows) || (err == nil && u.Status == "deleted") {
			return httpproblem.NotFound("user")
		} else if err != nil {
			return err
		}
		if err := q.UpsertGroupMember(ctx, dbgen.UpsertGroupMemberParams{GroupID: groupID, UserID: userID, MemberRole: role}); err != nil {
			return err
		}
		if err := audit.Record(ctx, q, actor, "group.member.set", "group", groupID.String(), map[string]string{"user": userID.String(), "role": role}); err != nil {
			return err
		}
		return s.touchConfig(ctx, tx)
	})
}

// RemoveMember takes a user out of a group.
func (s *Service) RemoveMember(ctx context.Context, actor, groupID, userID uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		n, err := q.RemoveGroupMember(ctx, dbgen.RemoveGroupMemberParams{GroupID: groupID, UserID: userID})
		if err != nil {
			return err
		}
		if n == 0 {
			return httpproblem.NotFound("membership")
		}
		if err := audit.Record(ctx, q, actor, "group.member.remove", "group", groupID.String(), map[string]string{"user": userID.String()}); err != nil {
			return err
		}
		return s.touchConfig(ctx, tx)
	})
}

// Members lists the members of a group.
func (s *Service) Members(ctx context.Context, groupID uuid.UUID) ([]dbgen.ListGroupMembersRow, error) {
	return s.db.Queries().ListGroupMembers(ctx, groupID)
}

// OfUser lists the groups a user belongs to.
func (s *Service) OfUser(ctx context.Context, userID uuid.UUID) ([]dbgen.ListGroupsOfUserRow, error) {
	return s.db.Queries().ListGroupsOfUser(ctx, userID)
}

// SearchUsers finds active users by name or e-mail (minimal fields).
func (s *Service) SearchUsers(ctx context.Context, q string) ([]dbgen.SearchDirectoryUsersRow, error) {
	return s.db.Queries().SearchDirectoryUsers(ctx, dbgen.SearchDirectoryUsersParams{Q: strings.TrimSpace(q), MaxRows: DirectoryLimit})
}

// SearchGroups finds groups by name.
func (s *Service) SearchGroups(ctx context.Context, q string) ([]dbgen.SearchDirectoryGroupsRow, error) {
	return s.db.Queries().SearchDirectoryGroups(ctx, dbgen.SearchDirectoryGroupsParams{Q: strings.TrimSpace(q), MaxRows: DirectoryLimit})
}
