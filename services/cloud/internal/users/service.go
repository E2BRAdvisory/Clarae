// Package users owns the users and devices tables: just-in-time provisioning,
// profile, effective quota and device registry (§2.6.1, §2.6.5).
package users

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/settings"
	"memobrain/services/cloud/internal/users/usersdb"
	"memobrain/shared/syncproto"
)

// QuotaUnlimited is the sentinel stored in quota_bytes_override and returned
// as the effective quota for unlimited accounts.
const QuotaUnlimited int64 = -1

// SettingDefaultQuota is the settings key of the global default quota.
const SettingDefaultQuota = "storage.default_quota_bytes"

// Service implements the users module.
type Service struct {
	db *db.DB
}

// NewService binds the module to the database.
func NewService(d *db.DB) *Service { return &Service{db: d} }

var _ auth.Provisioner = (*Service)(nil)

// lastLoginRefresh is how stale users.last_login_at may get before a request
// with an otherwise unchanged token writes the row again.
const lastLoginRefresh = 15 * time.Minute

// Provision resolves the user of the token claims and returns the Principal,
// creating the row on first sight. Most calls only read: the row is written
// when the token brings a profile or role change, or when last_login_at is
// older than lastLoginRefresh. Suspended and deleted accounts yield
// auth.ErrSuspended and are never written. An e-mail address already used by
// another live account yields auth.ErrIdentityConflict.
func (s *Service) Provision(ctx context.Context, c auth.Claims) (auth.Principal, error) {
	q := usersdb.New(s.db.Pool)
	username := c.PreferredUsername
	if username == "" {
		username = c.Subject
	}
	email := c.Email
	if email == "" {
		// Keycloak may omit the email for federated users: keep the row valid.
		email = c.Subject + "@no-email.invalid"
	}
	var displayName *string
	if c.Name != "" {
		displayName = &c.Name
	}
	tokenRole := string(auth.RoleFromRealmRoles(c.RealmRoles))

	cur, err := q.GetUserBySub(ctx, c.Subject)
	switch {
	case err == nil:
		if p := principalOf(cur); p.Status == auth.StatusSuspended || p.Status == auth.StatusDeleted {
			return auth.Principal{}, auth.ErrSuspended
		}
		if cur.Username == username && cur.Email == email && equalPtr(cur.DisplayName, displayName) &&
			cur.Role == EffectiveRole(cur.Role, cur.RoleChangedAt, tokenRole, c.IssuedAt) &&
			cur.LastLoginAt != nil && time.Since(*cur.LastLoginAt) < lastLoginRefresh {
			return principalOf(cur), nil
		}
	case !errors.Is(err, pgx.ErrNoRows):
		return auth.Principal{}, fmt.Errorf("provision user: %w", err)
	default:
		// A new subject, unless it belonged to a purged account: the purge
		// replaced its keycloak_sub, and the identity provider account may
		// still be enabled. Such a login must not create a fresh account.
		purged, err := q.IsSubjectPurged(ctx, SubjectHash(c.Subject))
		if err != nil {
			return auth.Principal{}, fmt.Errorf("provision user: %w", err)
		}
		if purged {
			return auth.Principal{}, auth.ErrSuspended
		}
	}

	id, err := uuid.NewV7()
	if err != nil {
		return auth.Principal{}, err
	}
	u, err := q.UpsertUserFromToken(ctx, usersdb.UpsertUserFromTokenParams{
		ID:          id,
		KeycloakSub: c.Subject,
		Username:    username,
		Email:       email,
		DisplayName: displayName,
		Role:        tokenRole,
		IssuedAt:    c.IssuedAt,
	})
	if db.IsUniqueViolation(err) {
		// The only unique key besides keycloak_sub (handled by the upsert) is
		// the e-mail of live accounts.
		return auth.Principal{}, fmt.Errorf("%w: subject %s", auth.ErrIdentityConflict, c.Subject)
	}
	if err != nil {
		return auth.Principal{}, fmt.Errorf("provision user: %w", err)
	}
	p := principalOf(u)
	if p.Status == auth.StatusSuspended || p.Status == auth.StatusDeleted {
		return auth.Principal{}, auth.ErrSuspended
	}
	return p, nil
}

// EffectiveRole is the role provisioning stores for a token: the realm role
// it carries, unless an administrator changed the role after the token was
// issued, in which case the stored role stands (ADR-0041). The token's iat
// has a precision of one second, so a token issued in the second of the
// change counts as older: the stored role then equals the new realm role.
// UpsertUserFromToken applies the same rule in SQL.
func EffectiveRole(stored string, changedAt *time.Time, tokenRole string, issuedAt time.Time) string {
	if changedAt != nil && !issuedAt.After(*changedAt) {
		return stored
	}
	return tokenRole
}

func principalOf(u usersdb.User) auth.Principal {
	return auth.Principal{
		UserID:   u.ID,
		Subject:  u.KeycloakSub,
		Username: u.Username,
		Role:     auth.Role(u.Role),
		Status:   auth.Status(u.Status),
	}
}

func equalPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// Me is the profile returned by GET /me.
type Me struct {
	User          usersdb.User
	QuotaBytes    int64
	ConfigVersion int64
}

// GetMe loads the profile and computes the effective quota.
func (s *Service) GetMe(ctx context.Context, userID uuid.UUID) (Me, error) {
	q := usersdb.New(s.db.Pool)
	u, err := q.GetUserByID(ctx, userID)
	if err != nil {
		return Me{}, err
	}
	quota, err := s.EffectiveQuota(ctx, u)
	if err != nil {
		return Me{}, err
	}
	// The revision the configuration change events carry (§3.6): a client
	// compares it with the version it holds to know whether to refetch.
	rev, err := settings.ConfigRevision(ctx, s.db.Pool)
	if err != nil {
		return Me{}, err
	}
	return Me{User: u, QuotaBytes: quota, ConfigVersion: rev}, nil
}

// EffectiveQuota applies the per-user override over the global default.
func (s *Service) EffectiveQuota(ctx context.Context, u usersdb.User) (int64, error) {
	if u.QuotaBytesOverride != nil {
		return *u.QuotaBytesOverride, nil
	}
	raw, ok, err := settings.Get(ctx, s.db.Pool, SettingDefaultQuota)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, fmt.Errorf("setting %s is missing", SettingDefaultQuota)
	}
	var quota int64
	if err := json.Unmarshal(raw, &quota); err != nil {
		return 0, fmt.Errorf("setting %s: %w", SettingDefaultQuota, err)
	}
	return quota, nil
}

// ListDevices returns the active devices of a user.
func (s *Service) ListDevices(ctx context.Context, userID uuid.UUID) ([]usersdb.Device, error) {
	return usersdb.New(s.db.Pool).ListDevices(ctx, userID)
}

// MaxIdempotencyKey is the longest Idempotency-Key accepted (api/openapi.yaml).
const MaxIdempotencyKey = 128

// RegisterDevice creates a device and returns it. A non-empty
// idempotencyKey makes the request safe to retry: the device an earlier
// attempt registered with the same key is returned instead of a second one.
func (s *Service) RegisterDevice(ctx context.Context, userID uuid.UUID, idempotencyKey, name, platform string, appVersion *string) (usersdb.Device, error) {
	if len(idempotencyKey) > MaxIdempotencyKey {
		return usersdb.Device{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "Idempotency-Key must be at most %d characters", MaxIdempotencyKey)
	}
	if d, ok, err := s.replayDevice(ctx, userID, idempotencyKey, platform); ok || err != nil {
		return d, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return usersdb.Device{}, err
	}
	var key *string
	if idempotencyKey != "" {
		key = &idempotencyKey
	}
	d, err := usersdb.New(s.db.Pool).CreateDevice(ctx, usersdb.CreateDeviceParams{
		ID:             id,
		UserID:         userID,
		Name:           name,
		Platform:       platform,
		AppVersion:     appVersion,
		IdempotencyKey: key,
	})
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == "devices_idempotency_key_uq" {
		// A concurrent attempt with the same key committed first.
		if d, ok, rerr := s.replayDevice(ctx, userID, idempotencyKey, platform); ok || rerr != nil {
			return d, rerr
		}
	}
	return d, err
}

// replayDevice returns the device an earlier POST /me/devices with the same
// Idempotency-Key registered (ok). A key reused for another platform is a
// client error, not a retry.
func (s *Service) replayDevice(ctx context.Context, userID uuid.UUID, key, platform string) (d usersdb.Device, ok bool, err error) {
	if key == "" {
		return usersdb.Device{}, false, nil
	}
	d, err = usersdb.New(s.db.Pool).GetDeviceByIdempotencyKey(ctx, usersdb.GetDeviceByIdempotencyKeyParams{UserID: userID, IdempotencyKey: &key})
	if errors.Is(err, pgx.ErrNoRows) {
		return usersdb.Device{}, false, nil
	}
	if err != nil {
		return usersdb.Device{}, false, err
	}
	if d.Platform != platform {
		return usersdb.Device{}, false, httpproblem.Errorf(syncproto.CodeValidationFailed, "this Idempotency-Key already registered a %s device", d.Platform)
	}
	return d, true, nil
}

// ErrDeviceNotFound is returned when the device does not exist, belongs to
// another user or is already revoked.
var ErrDeviceNotFound = errors.New("device not found")

// RevokeDevice revokes a device of the user.
func (s *Service) RevokeDevice(ctx context.Context, userID, deviceID uuid.UUID) error {
	n, err := usersdb.New(s.db.Pool).RevokeDevice(ctx, usersdb.RevokeDeviceParams{ID: deviceID, UserID: userID})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrDeviceNotFound
	}
	return nil
}
