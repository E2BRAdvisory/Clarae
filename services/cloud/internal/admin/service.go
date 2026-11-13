// Package admin implements the administration console API (§3.5.5, M5): users
// (mirrored in Keycloak), storage limits and overview, and the audit trail.
// Groups and configuration profiles keep their own modules; this package only
// exposes them to administrators through the HTTP layer.
package admin

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"

	"clarae/services/cloud/internal/admin/admindb"
	"clarae/services/cloud/internal/audit"
	"clarae/services/cloud/internal/configprofiles"
	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/httpproblem"
	"clarae/services/cloud/internal/keycloak"
	"clarae/services/cloud/internal/notify"
	"clarae/services/cloud/internal/pagination"
	"clarae/services/cloud/internal/privacy"
	"clarae/services/cloud/internal/settings"
	"clarae/services/cloud/internal/users"
	"clarae/shared/syncproto"
)

// Settings keys edited by the console (seeded by migration 0002).
const (
	keyDefaultQuota = "storage.default_quota_bytes"
	keyWarn         = "storage.warn_percent"
	keyCritical     = "storage.critical_percent"
	keyMaxFile      = "files.max_size_bytes"
	keyHistory      = "history.retention_days"
	keyHistoryDaily = "history.daily_retention_days"
)

// Unlimited is the quota value for accounts without a limit.
const Unlimited int64 = -1

// SessionInvalidator drops cached authentication state of a user (auth.Middleware),
// so a suspension takes effect on this replica immediately and elsewhere within the cache TTL.
type SessionInvalidator interface{ Invalidate(subject string) }

// QuotaResolver computes the effective quota of a user (users.Service).
type QuotaResolver interface {
	EffectiveQuota(ctx context.Context, u users.User) (int64, error)
}

// Service implements the admin module.
type Service struct {
	db    *db.DB
	kc    keycloak.Admin
	inv   SessionInvalidator
	quota QuotaResolver
	log   zerolog.Logger
}

// NewService wires the module; inv may be nil in unit tests.
func NewService(d *db.DB, kc keycloak.Admin, inv SessionInvalidator, q QuotaResolver, log zerolog.Logger) *Service {
	return &Service{db: d, kc: kc, inv: inv, quota: q, log: log}
}

func bad(format string, args ...any) *httpproblem.Error {
	return httpproblem.Errorf(syncproto.CodeValidationFailed, format, args...)
}

// kcError maps Keycloak failures to problems; missing admin configuration is a state error.
func kcError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, keycloak.ErrDisabled):
		return httpproblem.Errorf(syncproto.CodeInvalidState, "the identity provider admin API is not configured (KC_ADMIN_* settings)")
	case errors.Is(err, keycloak.ErrExists):
		return httpproblem.Errorf(syncproto.CodeNameInUse, "a user with this username or e-mail already exists")
	case errors.Is(err, keycloak.ErrNotFound):
		return httpproblem.NotFound("identity provider account")
	}
	return fmt.Errorf("identity provider: %w", err)
}

// tolerant reports whether a Keycloak error may be ignored for operations on users that
// live only in the database (standalone installations, or accounts removed from Keycloak).
func tolerant(err error) bool {
	return errors.Is(err, keycloak.ErrDisabled) || errors.Is(err, keycloak.ErrNotFound)
}

// UserView is a user with their effective quota.
type UserView struct {
	User       users.User
	QuotaBytes int64
}

func (s *Service) view(ctx context.Context, u users.User) (UserView, error) {
	q, err := s.quota.EffectiveQuota(ctx, u)
	return UserView{User: u, QuotaBytes: q}, err
}

// UserFilter selects and orders users.
type UserFilter struct {
	Query, Status, Role string
	Group               *uuid.UUID
	Sort                string
	Limit, Offset       int
}

// ListUsers returns a page of users and the total count of the filter.
func (s *Service) ListUsers(ctx context.Context, f UserFilter) ([]UserView, int, error) {
	if f.Status != "" && f.Status != "pending" && f.Status != "active" && f.Status != "suspended" {
		return nil, 0, bad("unknown status %q", f.Status)
	}
	if f.Role != "" && f.Role != "admin" && f.Role != "user" {
		return nil, 0, bad("unknown role %q", f.Role)
	}
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 50
	}
	rows, err := admindb.New(s.db.Pool).ListUsersAdmin(ctx, admindb.ListUsersAdminParams{
		Q: strings.TrimSpace(f.Query), Status: f.Status, Role: f.Role, GroupID: f.Group, Sort: f.Sort,
		SkipRows: clampInt32(f.Offset), MaxRows: clampInt32(f.Limit),
	})
	if err != nil {
		return nil, 0, err
	}
	out := make([]UserView, 0, len(rows))
	total := 0
	for _, r := range rows {
		total = int(r.Total)
		v, err := s.view(ctx, users.User{
			ID: r.ID, KeycloakSub: r.KeycloakSub, Username: r.Username, Email: r.Email, DisplayName: r.DisplayName,
			Role: r.Role, Status: r.Status, QuotaBytesOverride: r.QuotaBytesOverride, UsedBytes: r.UsedBytes,
			CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, LastLoginAt: r.LastLoginAt,
		})
		if err != nil {
			return nil, 0, err
		}
		out = append(out, v)
	}
	if len(rows) == 0 && f.Offset > 0 {
		// A page past the end still reports the real total.
		all, err := admindb.New(s.db.Pool).ListUsersAdmin(ctx, admindb.ListUsersAdminParams{
			Q: strings.TrimSpace(f.Query), Status: f.Status, Role: f.Role, GroupID: f.Group, Sort: f.Sort, MaxRows: 1,
		})
		if err == nil && len(all) > 0 {
			total = int(all[0].Total)
		}
	}
	return out, total, nil
}

func clampInt32(n int) int32 {
	switch {
	case n < 0:
		return 0
	case n > 1<<30:
		return 1 << 30
	}
	return int32(n)
}

// GetUser returns one user.
func (s *Service) GetUser(ctx context.Context, id uuid.UUID) (UserView, error) {
	u, err := s.user(ctx, s.db.Pool, id)
	if err != nil {
		return UserView{}, err
	}
	return s.view(ctx, u)
}

func (s *Service) user(ctx context.Context, tx db.DBTX, id uuid.UUID) (users.User, error) {
	u, err := users.GetUserByID(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && u.Status == "deleted") {
		return users.User{}, httpproblem.NotFound("user")
	}
	return u, err
}

// NewUser is the input of CreateUser.
type NewUser struct {
	Username, Email, DisplayName, Role, TemporaryPassword string
}

// CreateUser creates the account in Keycloak (with the required actions that make the user
// choose a password) and the matching row, which the first login links to by subject.
func (s *Service) CreateUser(ctx context.Context, actor uuid.UUID, in NewUser) (UserView, error) {
	username := strings.TrimSpace(in.Username)
	if username == "" || len([]rune(username)) > 100 || strings.ContainsAny(username, " \t\n/") {
		return UserView{}, bad("a username has 1..100 characters and no spaces")
	}
	addr, err := mail.ParseAddress(strings.TrimSpace(in.Email))
	if err != nil || addr.Address != strings.TrimSpace(in.Email) {
		return UserView{}, bad("invalid e-mail address")
	}
	role := in.Role
	if role == "" {
		role = "user"
	}
	if role != "user" && role != "admin" {
		return UserView{}, bad("role must be user or admin")
	}
	if in.TemporaryPassword != "" && len(in.TemporaryPassword) < 8 {
		return UserView{}, bad("the temporary password needs at least 8 characters")
	}
	sub, err := s.kc.CreateUser(ctx, keycloak.UserSpec{
		Username: username, Email: addr.Address, FirstName: in.DisplayName,
		TemporaryPassword: in.TemporaryPassword, Admin: role == "admin",
	})
	if err != nil {
		if sub != "" { // created but the role grant failed: do not leave a half-configured account
			_ = s.kc.SetEnabled(ctx, sub, false)
		}
		return UserView{}, kcError(err)
	}
	var display *string
	if d := strings.TrimSpace(in.DisplayName); d != "" {
		display = &d
	}
	var u users.User
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		u, err = users.InsertProvisionedUser(ctx, tx, users.InsertProvisionedUserParams{
			ID: uuid.Must(uuid.NewV7()), KeycloakSub: sub, Username: username, Email: addr.Address, DisplayName: display, Role: role,
		})
		if err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, "user.create", "user", u.ID.String(), map[string]string{"username": username, "role": role})
	})
	if err != nil {
		_ = s.kc.SetEnabled(ctx, sub, false)
		if db.IsUniqueViolation(err) {
			return UserView{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a user with this e-mail already exists")
		}
		return UserView{}, err
	}
	return s.view(ctx, u)
}

// UpdateUser changes display name and e-mail.
func (s *Service) UpdateUser(ctx context.Context, actor, id uuid.UUID, displayName, email *string) (UserView, error) {
	cur, err := s.user(ctx, s.db.Pool, id)
	if err != nil {
		return UserView{}, err
	}
	var em *string
	if email != nil {
		a, err := mail.ParseAddress(strings.TrimSpace(*email))
		if err != nil {
			return UserView{}, bad("invalid e-mail address")
		}
		em = &a.Address
	}
	var dn *string
	if displayName != nil {
		t := strings.TrimSpace(*displayName)
		dn = &t
	}
	// The database goes first, inside the transaction: a duplicate e-mail
	// fails there before Keycloak is touched, and a Keycloak failure rolls
	// the row back, so the two never disagree on the address (a mismatch
	// would lock the user out at the next login, see auth.ErrIdentityConflict).
	var u users.User
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		if u, err = users.UpdateUserProfile(ctx, tx, users.UpdateUserProfileParams{ID: id, DisplayName: dn, Email: em}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "user.update", "user", id.String(), nil); err != nil {
			return err
		}
		if err := s.kc.UpdateUser(ctx, cur.KeycloakSub, deref(em), deref(dn)); err != nil && !tolerant(err) {
			return kcError(err)
		}
		return nil
	})
	if db.IsUniqueViolation(err) {
		return UserView{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a user with this e-mail already exists")
	}
	if err != nil {
		return UserView{}, err
	}
	return s.view(ctx, u)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// lockTarget loads the user an operation may take out of service and, when
// they are an active administrator, locks every active administrator first
// and refuses the last one. The lock serialises concurrent suspensions,
// demotions and deletions: two administrators acting on each other at the
// same time cannot both see the other one and leave none. The row is read
// again under the lock, so the decision uses committed state.
func (s *Service) lockTarget(ctx context.Context, tx db.DBTX, id uuid.UUID) (users.User, error) {
	cur, err := s.user(ctx, tx, id)
	if err != nil || cur.Role != "admin" {
		return cur, err
	}
	n, err := users.LockActiveAdmins(ctx, tx)
	if err != nil {
		return users.User{}, err
	}
	if cur, err = s.user(ctx, tx, id); err != nil {
		return users.User{}, err
	}
	if cur.Role == "admin" && cur.Status == "active" && n <= 1 {
		return users.User{}, httpproblem.Errorf(syncproto.CodeInvalidState, "this is the last active administrator")
	}
	return cur, nil
}

// Suspend blocks the account: the database status stops API access (within the status
// cache TTL, at once on this replica), Keycloak stops new logins and ends the sessions.
func (s *Service) Suspend(ctx context.Context, actor, id uuid.UUID) (UserView, error) {
	if actor == id {
		return UserView{}, httpproblem.Errorf(syncproto.CodeInvalidState, "you cannot suspend yourself")
	}
	var u users.User
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := s.lockTarget(ctx, tx, id); err != nil {
			return err
		}
		var err error
		if u, err = users.SetUserStatus(ctx, tx, users.SetUserStatusParams{ID: id, Status: "suspended"}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "user.suspend", "user", id.String(), nil); err != nil {
			return err
		}
		return notify.PublishAccount(ctx, tx, notify.AccountEvent{User: id, Kind: notify.AccountSuspended})
	})
	if err != nil {
		return UserView{}, err
	}
	if s.inv != nil {
		s.inv.Invalidate(u.KeycloakSub)
	}
	if err := s.kc.SetEnabled(ctx, u.KeycloakSub, false); err != nil && !tolerant(err) {
		// The user is already blocked on the API; a retry completes the Keycloak side.
		return UserView{}, kcError(err)
	}
	return s.view(ctx, u)
}

// Activate lifts a suspension.
func (s *Service) Activate(ctx context.Context, actor, id uuid.UUID) (UserView, error) {
	cur, err := s.user(ctx, s.db.Pool, id)
	if err != nil {
		return UserView{}, err
	}
	if err := s.kc.SetEnabled(ctx, cur.KeycloakSub, true); err != nil && !tolerant(err) {
		return UserView{}, kcError(err)
	}
	var u users.User
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		if u, err = users.SetUserStatus(ctx, tx, users.SetUserStatusParams{ID: id, Status: "active"}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "user.activate", "user", id.String(), nil); err != nil {
			return err
		}
		return notify.PublishAccount(ctx, tx, notify.AccountEvent{User: id, Kind: notify.AccountActivated})
	})
	if err != nil {
		return UserView{}, err
	}
	if s.inv != nil {
		s.inv.Invalidate(u.KeycloakSub)
	}
	return s.view(ctx, u)
}

// Delete removes the account the same way as a self-deletion
// (privacy.DeleteAccount): the row is anonymised at once, the vaults enter the
// retention period (the nightly job purges them afterwards, §2.6.2),
// memberships, grants, uploads and ready exports go, and the account is
// disabled in Keycloak. The administrator confirmed in the console; private
// vaults need no acknowledgement here.
func (s *Service) Delete(ctx context.Context, actor, id uuid.UUID) error {
	if actor == id {
		return httpproblem.Errorf(syncproto.CodeInvalidState, "you cannot delete yourself")
	}
	var res privacy.Deletion
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		if res, err = privacy.DeleteAccount(ctx, tx, id, nil); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, "user.delete", "user", id.String(), map[string]any{
			"vaults": res.Vaults, "private_vaults": res.PrivateVaults, "memberships": res.Memberships, "reattributed_grants": res.ReattributedGrants,
		})
	})
	if err != nil {
		return err
	}
	if s.inv != nil {
		s.inv.Invalidate(res.Subject)
	}
	if err := s.kc.SetEnabled(ctx, res.Subject, false); err != nil && !tolerant(err) {
		return kcError(err)
	}
	return nil
}

// ResetPassword requires a new password at the next login.
func (s *Service) ResetPassword(ctx context.Context, actor, id uuid.UUID) (bool, error) {
	cur, err := s.user(ctx, s.db.Pool, id)
	if err != nil {
		return false, err
	}
	sent, err := s.kc.RequirePasswordReset(ctx, cur.KeycloakSub)
	if err != nil {
		return false, kcError(err)
	}
	return sent, s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		return audit.Record(ctx, tx, actor, "user.reset_password", "user", id.String(), map[string]bool{"email_sent": sent})
	})
}

// SetRole changes the global role in Keycloak and in the database. The
// database role is authoritative from then on over the tokens issued before
// the change (role_changed_at, ADR-0041): a demotion applies at the next
// request even though the user's access token still carries the old realm
// role, and a token issued later mirrors Keycloak again. The Keycloak side
// is required: without the admin API, the next token would restore the role.
func (s *Service) SetRole(ctx context.Context, actor, id uuid.UUID, role string) (UserView, error) {
	if role != "admin" && role != "user" {
		return UserView{}, bad("role must be user or admin")
	}
	if role == "user" && actor == id {
		return UserView{}, httpproblem.Errorf(syncproto.CodeInvalidState, "you cannot remove your own administrator role")
	}
	cur, err := s.user(ctx, s.db.Pool, id)
	if err != nil {
		return UserView{}, err
	}
	if cur.Role == role {
		return s.view(ctx, cur)
	}
	var u users.User
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		cur, err := s.lockTarget(ctx, tx, id)
		if err != nil {
			return err
		}
		if cur.Role == role {
			u = cur
			return nil
		}
		// Inside the transaction: if Keycloak refuses, nothing changes here;
		// the last-admin lock is held until the change commits.
		if err := s.kc.SetAdmin(ctx, cur.KeycloakSub, role == "admin"); err != nil && !errors.Is(err, keycloak.ErrNotFound) {
			return kcError(err)
		}
		if u, err = users.SetUserRole(ctx, tx, users.SetUserRoleParams{ID: id, Role: role}); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, "user.role", "user", id.String(), map[string]string{"from": cur.Role, "to": role})
	})
	if err != nil {
		return UserView{}, err
	}
	if s.inv != nil {
		s.inv.Invalidate(u.KeycloakSub)
	}
	return s.view(ctx, u)
}

func validQuota(q *int64) error {
	if q != nil && *q < Unlimited {
		return bad("quota_bytes must be -1 (unlimited), 0 or more")
	}
	return nil
}

// SetQuota sets or clears (nil) the quota override of a user.
func (s *Service) SetQuota(ctx context.Context, actor, id uuid.UUID, quota *int64) (UserView, error) {
	if err := validQuota(quota); err != nil {
		return UserView{}, err
	}
	var u users.User
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := s.user(ctx, tx, id); err != nil {
			return err
		}
		var err error
		if u, err = users.SetUserQuotaOverride(ctx, tx, users.SetUserQuotaOverrideParams{ID: id, QuotaBytesOverride: quota}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "user.quota", "user", id.String(), map[string]*int64{"quota_bytes": quota}); err != nil {
			return err
		}
		return notify.PublishAccount(ctx, tx, notify.AccountEvent{User: id, Kind: notify.AccountQuotaChanged})
	})
	if err != nil {
		return UserView{}, err
	}
	return s.view(ctx, u)
}

// BulkQuota applies one quota override to many users and returns how many changed.
func (s *Service) BulkQuota(ctx context.Context, actor uuid.UUID, ids []uuid.UUID, quota *int64) (int, error) {
	if err := validQuota(quota); err != nil {
		return 0, err
	}
	if len(ids) == 0 || len(ids) > 500 {
		return 0, bad("user_ids has 1..500 entries")
	}
	var n int64
	err := s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		if n, err = users.BulkSetUserQuota(ctx, tx, users.BulkSetUserQuotaParams{Quota: quota, Ids: ids}); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "user.quota.bulk", "user", "", map[string]any{"count": n, "quota_bytes": quota}); err != nil {
			return err
		}
		for _, id := range ids {
			if err := notify.PublishAccount(ctx, tx, notify.AccountEvent{User: id, Kind: notify.AccountQuotaChanged}); err != nil {
				return err
			}
		}
		return nil
	})
	return int(n), err
}

// Vaults lists the vaults of a user (metadata only: name, kind, size), deleted ones included.
func (s *Service) Vaults(ctx context.Context, id uuid.UUID) ([]admindb.ListVaultsOfUserAdminRow, error) {
	if _, err := s.user(ctx, s.db.Pool, id); err != nil {
		return nil, err
	}
	return admindb.New(s.db.Pool).ListVaultsOfUserAdmin(ctx, id)
}

// Devices lists the active devices of a user.
func (s *Service) Devices(ctx context.Context, id uuid.UUID) ([]admindb.Device, error) {
	if _, err := s.user(ctx, s.db.Pool, id); err != nil {
		return nil, err
	}
	return admindb.New(s.db.Pool).ListDevicesOfUserAdmin(ctx, id)
}

// Sessions lists the open Keycloak sessions of a user.
func (s *Service) Sessions(ctx context.Context, id uuid.UUID) ([]keycloak.Session, error) {
	u, err := s.user(ctx, s.db.Pool, id)
	if err != nil {
		return nil, err
	}
	out, err := s.kc.Sessions(ctx, u.KeycloakSub)
	if err != nil {
		if tolerant(err) {
			return []keycloak.Session{}, nil
		}
		return nil, kcError(err)
	}
	return out, nil
}

// StorageSettings are the limits edited in the console.
type StorageSettings struct {
	DefaultQuotaBytes         int64
	WarnPercent               int
	CriticalPercent           int
	HistoryRetentionDays      int
	HistoryDailyRetentionDays int
	MaxFileSizeBytes          int64
}

func (s *Service) number(ctx context.Context, tx db.DBTX, key string) (int64, error) {
	raw, ok, err := settings.Get(ctx, tx, key)
	if err == nil && !ok {
		err = pgx.ErrNoRows
	}
	if err != nil {
		return 0, fmt.Errorf("setting %s: %w", key, err)
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, fmt.Errorf("setting %s: %w", key, err)
	}
	return n, nil
}

// StorageSettings reads the current limits.
func (s *Service) StorageSettings(ctx context.Context) (StorageSettings, error) {
	conn := s.db.Pool
	var out StorageSettings
	for _, f := range []struct {
		key string
		set func(int64)
	}{
		{keyDefaultQuota, func(n int64) { out.DefaultQuotaBytes = n }},
		{keyWarn, func(n int64) { out.WarnPercent = int(n) }},
		{keyCritical, func(n int64) { out.CriticalPercent = int(n) }},
		{keyHistory, func(n int64) { out.HistoryRetentionDays = int(n) }},
		{keyHistoryDaily, func(n int64) { out.HistoryDailyRetentionDays = int(n) }},
		{keyMaxFile, func(n int64) { out.MaxFileSizeBytes = n }},
	} {
		n, err := s.number(ctx, conn, f.key)
		if err != nil {
			return StorageSettings{}, err
		}
		f.set(n)
	}
	return out, nil
}

// PutStorageSettings validates and stores the limits.
func (s *Service) PutStorageSettings(ctx context.Context, actor uuid.UUID, in StorageSettings) (StorageSettings, error) {
	switch {
	case in.DefaultQuotaBytes < 0:
		return StorageSettings{}, bad("default_quota_bytes cannot be negative")
	case in.WarnPercent < 1 || in.CriticalPercent > 100 || in.WarnPercent >= in.CriticalPercent:
		return StorageSettings{}, bad("thresholds must satisfy 1 <= warn_percent < critical_percent <= 100")
	case in.HistoryRetentionDays < 1 || in.HistoryDailyRetentionDays < in.HistoryRetentionDays:
		return StorageSettings{}, bad("history retention must be at least 1 day and the daily retention not shorter than it")
	case in.MaxFileSizeBytes < 1024:
		return StorageSettings{}, bad("max_file_size_bytes must be at least 1024")
	}
	before, err := s.StorageSettings(ctx)
	if err != nil {
		return StorageSettings{}, err
	}
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		for key, v := range map[string]int64{
			keyDefaultQuota: in.DefaultQuotaBytes, keyWarn: int64(in.WarnPercent), keyCritical: int64(in.CriticalPercent),
			keyHistory: int64(in.HistoryRetentionDays), keyHistoryDaily: int64(in.HistoryDailyRetentionDays), keyMaxFile: in.MaxFileSizeBytes,
		} {
			if err := settings.Set(ctx, tx, key, []byte(strconv.FormatInt(v, 10)), &actor); err != nil {
				return err
			}
		}
		return audit.Record(ctx, tx, actor, "settings.storage", "settings", "storage", map[string]any{"before": before, "after": in})
	})
	if err != nil {
		return StorageSettings{}, err
	}
	return in, nil
}

// Overview is the storage dashboard.
type Overview struct {
	DefaultQuotaBytes int64
	TotalUsedBytes    int64
	UserCount         int
	OverWarn          int
	OverCritical      int
	Top               []admindb.TopConsumersRow
	Trend             []admindb.StorageSnapshot
}

// trendDays is the window of the dashboard trend.
const trendDays = 30

// StorageOverview computes totals, the top consumers, the users beyond the thresholds and
// the trend; reading it also records today's snapshot, so the trend fills without a job.
func (s *Service) StorageOverview(ctx context.Context) (Overview, error) {
	conn := s.db.Pool
	q := admindb.New(conn)
	set, err := s.StorageSettings(ctx)
	if err != nil {
		return Overview{}, err
	}
	totals, err := q.StorageTotals(ctx)
	if err != nil {
		return Overview{}, err
	}
	out := Overview{DefaultQuotaBytes: set.DefaultQuotaBytes, TotalUsedBytes: totals.TotalUsed, UserCount: int(totals.UserCount)}
	if out.Top, err = q.TopConsumers(ctx, admindb.TopConsumersParams{DefaultQuota: set.DefaultQuotaBytes, MaxRows: 10}); err != nil {
		return Overview{}, err
	}
	warn, err := q.CountUsersOverPercent(ctx, admindb.CountUsersOverPercentParams{DefaultQuota: set.DefaultQuotaBytes, Percent: int64(set.WarnPercent)})
	if err != nil {
		return Overview{}, err
	}
	crit, err := q.CountUsersOverPercent(ctx, admindb.CountUsersOverPercentParams{DefaultQuota: set.DefaultQuotaBytes, Percent: int64(set.CriticalPercent)})
	if err != nil {
		return Overview{}, err
	}
	out.OverWarn, out.OverCritical = int(warn), int(crit)
	if err := q.UpsertStorageSnapshot(ctx, totals.TotalUsed); err != nil {
		return Overview{}, err
	}
	if out.Trend, err = q.ListStorageSnapshots(ctx, trendDays); err != nil {
		return Overview{}, err
	}
	return out, nil
}

// AuditFilter selects audit entries.
type AuditFilter struct {
	Actor    *uuid.UUID
	Action   string
	Target   string
	From, To *time.Time
}

// AuditPage returns up to limit entries older than cursor and the cursor of the next page ("" at the end).
func (s *Service) AuditPage(ctx context.Context, f AuditFilter, limit int, cursor string) ([]admindb.ListAuditEntriesRow, string, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var before *int64
	if cursor != "" {
		n, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || n <= 0 {
			return nil, "", bad("invalid cursor")
		}
		before = &n
	}
	rows, err := admindb.New(s.db.Pool).ListAuditEntries(ctx, admindb.ListAuditEntriesParams{
		ActorID: f.Actor, Action: f.Action, Target: f.Target, FromAt: f.From, ToAt: f.To, BeforeID: before, MaxRows: clampInt32(limit + 1),
	})
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = strconv.FormatInt(rows[len(rows)-1].ID, 10)
	}
	return rows, next, nil
}

// CSVRowLimit caps the CSV export of the audit trail.
const CSVRowLimit = 50000

// AuditCSV renders the entries matching the filter, newest first, as CSV.
func (s *Service) AuditCSV(ctx context.Context, f AuditFilter) ([]byte, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"id", "at", "actor_id", "actor", "action", "target_type", "target_id", "details", "ip"})
	cursor, written := "", 0
	for written < CSVRowLimit {
		rows, next, err := s.AuditPage(ctx, f, 500, cursor)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			actorID := ""
			if r.ActorID != nil {
				actorID = r.ActorID.String()
			}
			_ = w.Write(csvSafeRow(
				strconv.FormatInt(r.ID, 10), r.At.UTC().Format(time.RFC3339), actorID, deref(r.ActorName), r.Action,
				deref(r.TargetType), deref(r.TargetID), string(r.Details), r.Ip,
			))
			written++
		}
		if next == "" {
			break
		}
		cursor = next
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// csvSafeRow applies csvSafe to every cell. Every column goes through it, not
// only the ones that look user-controlled today: actor names come from the
// identity provider, targets and details from user input, and a column that
// is safe now (ids, timestamps, addresses) stays safe through it.
func csvSafeRow(cells ...string) []string {
	for i, c := range cells {
		cells[i] = csvSafe(c)
	}
	return cells
}

// csvSafe neutralises spreadsheet formula injection: a cell starting with = + - @
// (or a tab or carriage return, which some spreadsheets skip before reading
// the formula) is read as a formula by Excel, and audit fields can carry text
// chosen by users (names, paths).
func csvSafe(v string) string {
	if v != "" && strings.ContainsRune("=+-@\t\r", rune(v[0])) {
		return "'" + v
	}
	return v
}

// groupsList tags the cursors of Groups.
const groupsList = "groups"

// Groups returns a page of at most limit groups by name, with their member
// counts, after cursor ("" for the first page), and the cursor of the next
// page (nil on the last). The cursor is the name of the last group (unique):
// a group created or renamed meanwhile lands where its name sorts.
func (s *Service) Groups(ctx context.Context, limit int, cursor string) ([]admindb.ListGroupsWithCountsRow, *string, error) {
	after, err := pagination.Decode(groupsList, cursor)
	if err != nil {
		return nil, nil, err
	}
	p := admindb.ListGroupsWithCountsParams{MaxRows: pagination.FetchLimit(limit)}
	if after != nil {
		p.AfterName = &after.K
	}
	rows, err := admindb.New(s.db.Pool).ListGroupsWithCounts(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	rows, more := pagination.Trim(rows, limit)
	if !more {
		return rows, nil, nil
	}
	return rows, pagination.Cursor(pagination.Key{List: groupsList, K: rows[len(rows)-1].Name}), nil
}

// Group returns one group with its member count.
func (s *Service) Group(ctx context.Context, id uuid.UUID) (admindb.GetGroupWithCountRow, error) {
	g, err := admindb.New(s.db.Pool).GetGroupWithCount(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return admindb.GetGroupWithCountRow{}, httpproblem.NotFound("group")
	}
	return g, err
}

// GroupAssignments lists the profiles assigned to a group.
func (s *Service) GroupAssignments(ctx context.Context, id uuid.UUID) ([]configprofiles.ConfigAssignment, error) {
	if _, err := s.Group(ctx, id); err != nil {
		return nil, err
	}
	return configprofiles.ListGroupAssignments(ctx, s.db.Pool, id)
}
