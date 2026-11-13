package users

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// usersdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"
	"crypto/sha256"
	"strings"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/users/usersdb"
)

// Types of the exported queries.
type (
	BulkSetUserQuotaParams      = usersdb.BulkSetUserQuotaParams
	Device                      = usersdb.Device
	GetDeviceParams             = usersdb.GetDeviceParams
	GetUserBriefRow             = usersdb.GetUserBriefRow
	InsertProvisionedUserParams = usersdb.InsertProvisionedUserParams
	SearchDirectoryUsersRow     = usersdb.SearchDirectoryUsersRow
	SetUserQuotaOverrideParams  = usersdb.SetUserQuotaOverrideParams
	SetUserRoleParams           = usersdb.SetUserRoleParams
	SetUserStatusParams         = usersdb.SetUserStatusParams
	TouchDeviceParams           = usersdb.TouchDeviceParams
	UpdateUserProfileParams     = usersdb.UpdateUserProfileParams
	User                        = usersdb.User
)

// GetUserByID runs the GetUserByID query on tx.
func GetUserByID(ctx context.Context, tx db.DBTX, id uuid.UUID) (User, error) {
	return usersdb.New(tx).GetUserByID(ctx, id)
}

// CountActiveAdmins runs the CountActiveAdmins query on tx.
func CountActiveAdmins(ctx context.Context, tx db.DBTX) (int32, error) {
	return usersdb.New(tx).CountActiveAdmins(ctx)
}

// LockActiveAdmins takes the row lock of every active administrator on tx
// (held until tx ends) and returns how many there are. Every operation that
// can take an administrator out of service (suspension, demotion, deletion)
// calls it before deciding, so two of them running at once cannot both see
// a second administrator and leave none: the later one waits and then counts
// the committed result.
func LockActiveAdmins(ctx context.Context, tx db.DBTX) (int, error) {
	ids, err := usersdb.New(tx).LockActiveAdmins(ctx)
	return len(ids), err
}

// InsertProvisionedUser runs the InsertProvisionedUser query on tx.
func InsertProvisionedUser(ctx context.Context, tx db.DBTX, arg InsertProvisionedUserParams) (User, error) {
	return usersdb.New(tx).InsertProvisionedUser(ctx, arg)
}

// SetUserStatus runs the SetUserStatus query on tx.
func SetUserStatus(ctx context.Context, tx db.DBTX, arg SetUserStatusParams) (User, error) {
	return usersdb.New(tx).SetUserStatus(ctx, arg)
}

// SetUserRole runs the SetUserRole query on tx.
func SetUserRole(ctx context.Context, tx db.DBTX, arg SetUserRoleParams) (User, error) {
	return usersdb.New(tx).SetUserRole(ctx, arg)
}

// SetUserQuotaOverride runs the SetUserQuotaOverride query on tx.
func SetUserQuotaOverride(ctx context.Context, tx db.DBTX, arg SetUserQuotaOverrideParams) (User, error) {
	return usersdb.New(tx).SetUserQuotaOverride(ctx, arg)
}

// BulkSetUserQuota runs the BulkSetUserQuota query on tx.
func BulkSetUserQuota(ctx context.Context, tx db.DBTX, arg BulkSetUserQuotaParams) (int64, error) {
	return usersdb.New(tx).BulkSetUserQuota(ctx, arg)
}

// UpdateUserProfile runs the UpdateUserProfile query on tx.
func UpdateUserProfile(ctx context.Context, tx db.DBTX, arg UpdateUserProfileParams) (User, error) {
	return usersdb.New(tx).UpdateUserProfile(ctx, arg)
}

// SearchDirectoryUsers finds active users for the sharing directory: q
// matches a substring of the username or display name, or the whole e-mail
// address (case-insensitive). The e-mail is never matched in part, so the
// directory cannot confirm addresses piece by piece (ADR-0041).
func SearchDirectoryUsers(ctx context.Context, tx db.DBTX, q string, limit int32) ([]SearchDirectoryUsersRow, error) {
	return usersdb.New(tx).SearchDirectoryUsers(ctx, usersdb.SearchDirectoryUsersParams{Q: q, Pattern: likeEscape(q), MaxRows: limit})
}

// likeEscape makes the LIKE wildcards of s literal (the default escape character is backslash).
func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// GetUserBrief runs the GetUserBrief query on tx.
func GetUserBrief(ctx context.Context, tx db.DBTX, id uuid.UUID) (GetUserBriefRow, error) {
	return usersdb.New(tx).GetUserBrief(ctx, id)
}

// GetDevice runs the GetDevice query on tx.
func GetDevice(ctx context.Context, tx db.DBTX, arg GetDeviceParams) (Device, error) {
	return usersdb.New(tx).GetDevice(ctx, arg)
}

// TouchDevice runs the TouchDevice query on tx.
func TouchDevice(ctx context.Context, tx db.DBTX, arg TouchDeviceParams) error {
	return usersdb.New(tx).TouchDevice(ctx, arg)
}

// SubjectHash is the fingerprint kept for a purged subject: the SHA-256 of
// its UTF-8 bytes, which in SQL is sha256(convert_to(subject, 'UTF8')).
func SubjectHash(subject string) []byte {
	h := sha256.Sum256([]byte(subject))
	return h[:]
}

// RecordPurgedSubject remembers on tx that the account of subject was
// purged, so that provisioning refuses the subject from then on (the purge
// replaces users.keycloak_sub). Idempotent.
func RecordPurgedSubject(ctx context.Context, tx db.DBTX, subject string) error {
	return usersdb.New(tx).InsertPurgedSubject(ctx, SubjectHash(subject))
}
