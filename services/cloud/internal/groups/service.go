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

	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/groups/groupsdb"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/users"
	"memobrain/shared/syncproto"
)

// DirectoryLimit caps the answers of the directory endpoints.
const DirectoryLimit = 20

// ConfigNotifier is told when memberships change, because the effective
// configuration of the affected users may change with them.
type ConfigNotifier interface {
	Changed(ctx context.Context, tx pgx.Tx) error
}

// Shares is what group changes need of the sharing module, which owns the
// share grants and depends on this one: it is wired in by the application
// (ADR-0033).
type Shares interface {
	// DeleteGrantsOfPrincipal deletes the share grants given to a principal.
	DeleteGrantsOfPrincipal(ctx context.Context, tx db.DBTX, principalType string, principalID uuid.UUID) error
	// GroupChange runs change, which alters the members of a group or removes
	// it, and tells the users listed which shares they gained or lost with it.
	GroupChange(ctx context.Context, tx pgx.Tx, actor, groupID uuid.UUID, users []uuid.UUID, change func() error) error
}

// Service implements the groups module.
type Service struct {
	db     *db.DB
	config ConfigNotifier
	// Grants removes the grants of a deleted group and tells the members about
	// the shares a membership change gives or takes (nil in unit tests).
	Grants Shares
}

// shareChange runs change through Grants.GroupChange when the sharing module
// is wired in.
func (s *Service) shareChange(ctx context.Context, tx pgx.Tx, actor, groupID uuid.UUID, users []uuid.UUID, change func() error) error {
	if s.Grants == nil {
		return change()
	}
	return s.Grants.GroupChange(ctx, tx, actor, groupID, users, change)
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
func (s *Service) Create(ctx context.Context, actor uuid.UUID, name, description string) (groupsdb.Group, error) {
	n, err := validName(name)
	if err != nil {
		return groupsdb.Group{}, err
	}
	var desc *string
	if description != "" {
		desc = &description
	}
	var g groupsdb.Group
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := groupsdb.New(tx)
		var err error
		if g, err = q.CreateGroup(ctx, groupsdb.CreateGroupParams{ID: uuid.Must(uuid.NewV7()), Name: n, Description: desc}); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, "group.create", "group", g.ID.String(), map[string]string{"name": n})
	})
	if nameTaken(err) {
		return groupsdb.Group{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a group named %q exists", n)
	}
	return g, err
}

// Get returns a group.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (groupsdb.Group, error) {
	g, err := groupsdb.New(s.db.Pool).GetGroup(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return groupsdb.Group{}, httpproblem.NotFound("group")
	}
	return g, err
}

// List returns every group.
func (s *Service) List(ctx context.Context) ([]groupsdb.Group, error) {
	return groupsdb.New(s.db.Pool).ListGroups(ctx)
}

// Update renames a group or changes its description.
func (s *Service) Update(ctx context.Context, actor, id uuid.UUID, name, description string) (groupsdb.Group, error) {
	n, err := validName(name)
	if err != nil {
		return groupsdb.Group{}, err
	}
	var desc *string
	if description != "" {
		desc = &description
	}
	var g groupsdb.Group
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := groupsdb.New(tx)
		var err error
		if g, err = q.UpdateGroup(ctx, groupsdb.UpdateGroupParams{ID: id, Name: n, Description: desc}); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, "group.update", "group", id.String(), map[string]string{"name": n})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return groupsdb.Group{}, httpproblem.NotFound("group")
	}
	if nameTaken(err) {
		return groupsdb.Group{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a group named %q exists", n)
	}
	return g, err
}

// Delete removes a group; its memberships, grants to it and profile assignments go with it.
func (s *Service) Delete(ctx context.Context, actor, id uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := groupsdb.New(tx)
		members, err := q.ListGroupMemberIDs(ctx, id)
		if err != nil {
			return err
		}
		err = s.shareChange(ctx, tx, actor, id, members, func() error {
			n, err := q.DeleteGroup(ctx, id)
			if err != nil {
				return err
			}
			if n == 0 {
				return httpproblem.NotFound("group")
			}
			// Grants to the group are rows of share_grants keyed by (type, id) without a
			// foreign key: remove them so no dangling principal keeps a share alive.
			if s.Grants != nil {
				return s.Grants.DeleteGrantsOfPrincipal(ctx, tx, "group", id)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "group.delete", "group", id.String(), nil); err != nil {
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
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := groupsdb.New(tx)
		if _, err := q.GetGroup(ctx, groupID); errors.Is(err, pgx.ErrNoRows) {
			return httpproblem.NotFound("group")
		} else if err != nil {
			return err
		}
		if u, err := users.GetUserBrief(ctx, tx, userID); errors.Is(err, pgx.ErrNoRows) || (err == nil && u.Status == "deleted") {
			return httpproblem.NotFound("user")
		} else if err != nil {
			return err
		}
		// A new member reaches the shares granted to the group at once.
		if err := s.shareChange(ctx, tx, actor, groupID, []uuid.UUID{userID}, func() error {
			return q.UpsertGroupMember(ctx, groupsdb.UpsertGroupMemberParams{GroupID: groupID, UserID: userID, MemberRole: role})
		}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "group.member.set", "group", groupID.String(), map[string]string{"user": userID.String(), "role": role}); err != nil {
			return err
		}
		return s.touchConfig(ctx, tx)
	})
}

// RemoveMember takes a user out of a group.
func (s *Service) RemoveMember(ctx context.Context, actor, groupID, userID uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := groupsdb.New(tx)
		// A former member loses the shares that reached them only through the group.
		err := s.shareChange(ctx, tx, actor, groupID, []uuid.UUID{userID}, func() error {
			n, err := q.RemoveGroupMember(ctx, groupsdb.RemoveGroupMemberParams{GroupID: groupID, UserID: userID})
			if err != nil {
				return err
			}
			if n == 0 {
				return httpproblem.NotFound("membership")
			}
			return nil
		})
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "group.member.remove", "group", groupID.String(), map[string]string{"user": userID.String()}); err != nil {
			return err
		}
		return s.touchConfig(ctx, tx)
	})
}

// Members lists the members of a group.
func (s *Service) Members(ctx context.Context, groupID uuid.UUID) ([]groupsdb.ListGroupMembersRow, error) {
	return groupsdb.New(s.db.Pool).ListGroupMembers(ctx, groupID)
}

// OfUser lists the groups a user belongs to.
func (s *Service) OfUser(ctx context.Context, userID uuid.UUID) ([]groupsdb.ListGroupsOfUserRow, error) {
	return groupsdb.New(s.db.Pool).ListGroupsOfUser(ctx, userID)
}

// SearchUsers finds active users by name or e-mail (minimal fields).
func (s *Service) SearchUsers(ctx context.Context, q string) ([]users.SearchDirectoryUsersRow, error) {
	return users.SearchDirectoryUsers(ctx, s.db.Pool, strings.TrimSpace(q), DirectoryLimit)
}

// SearchGroups finds groups by name.
func (s *Service) SearchGroups(ctx context.Context, q string) ([]groupsdb.SearchDirectoryGroupsRow, error) {
	// The LIKE wildcards in q are literal characters of a name.
	q = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.TrimSpace(q))
	return groupsdb.New(s.db.Pool).SearchDirectoryGroups(ctx, groupsdb.SearchDirectoryGroupsParams{Q: q, MaxRows: DirectoryLimit})
}
