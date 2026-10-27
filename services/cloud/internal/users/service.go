// Package users owns the users and devices tables: just-in-time provisioning,
// profile, effective quota and device registry (§2.6.1, §2.6.5).
package users

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/db/dbgen"
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

// Provision upserts the user from token claims and returns the Principal.
// Suspended and deleted accounts yield auth.ErrSuspended.
func (s *Service) Provision(ctx context.Context, c auth.Claims) (auth.Principal, error) {
	q := s.db.Queries()
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
	id, err := uuid.NewV7()
	if err != nil {
		return auth.Principal{}, err
	}
	u, err := q.UpsertUserFromToken(ctx, dbgen.UpsertUserFromTokenParams{
		ID:          id,
		KeycloakSub: c.Subject,
		Username:    username,
		Email:       email,
		DisplayName: displayName,
		Role:        string(auth.RoleFromRealmRoles(c.RealmRoles)),
	})
	if err != nil {
		return auth.Principal{}, fmt.Errorf("provision user: %w", err)
	}
	p := auth.Principal{
		UserID:   u.ID,
		Subject:  u.KeycloakSub,
		Username: u.Username,
		Role:     auth.Role(u.Role),
		Status:   auth.Status(u.Status),
	}
	if p.Status == auth.StatusSuspended || p.Status == auth.StatusDeleted {
		return auth.Principal{}, auth.ErrSuspended
	}
	return p, nil
}

// Me is the profile returned by GET /me.
type Me struct {
	User          dbgen.User
	QuotaBytes    int64
	ConfigVersion int
}

// GetMe loads the profile and computes the effective quota.
func (s *Service) GetMe(ctx context.Context, userID uuid.UUID) (Me, error) {
	q := s.db.Queries()
	u, err := q.GetUserByID(ctx, userID)
	if err != nil {
		return Me{}, err
	}
	quota, err := s.EffectiveQuota(ctx, u)
	if err != nil {
		return Me{}, err
	}
	return Me{User: u, QuotaBytes: quota, ConfigVersion: 0}, nil
}

// EffectiveQuota applies the per-user override over the global default.
func (s *Service) EffectiveQuota(ctx context.Context, u dbgen.User) (int64, error) {
	if u.QuotaBytesOverride != nil {
		return *u.QuotaBytesOverride, nil
	}
	raw, err := s.db.Queries().GetSetting(ctx, SettingDefaultQuota)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("setting %s is missing", SettingDefaultQuota)
	}
	if err != nil {
		return 0, err
	}
	var quota int64
	if err := json.Unmarshal(raw, &quota); err != nil {
		return 0, fmt.Errorf("setting %s: %w", SettingDefaultQuota, err)
	}
	return quota, nil
}

// ListDevices returns the active devices of a user.
func (s *Service) ListDevices(ctx context.Context, userID uuid.UUID) ([]dbgen.Device, error) {
	return s.db.Queries().ListDevices(ctx, userID)
}

// RegisterDevice creates a device and returns it.
func (s *Service) RegisterDevice(ctx context.Context, userID uuid.UUID, name, platform string, appVersion *string) (dbgen.Device, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return dbgen.Device{}, err
	}
	return s.db.Queries().CreateDevice(ctx, dbgen.CreateDeviceParams{
		ID:         id,
		UserID:     userID,
		Name:       name,
		Platform:   platform,
		AppVersion: appVersion,
	})
}

// ErrDeviceNotFound is returned when the device does not exist, belongs to
// another user or is already revoked.
var ErrDeviceNotFound = errors.New("device not found")

// RevokeDevice revokes a device of the user.
func (s *Service) RevokeDevice(ctx context.Context, userID, deviceID uuid.UUID) error {
	n, err := s.db.Queries().RevokeDevice(ctx, dbgen.RevokeDeviceParams{ID: deviceID, UserID: userID})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrDeviceNotFound
	}
	return nil
}
