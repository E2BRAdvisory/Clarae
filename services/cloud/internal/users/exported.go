package users

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// usersdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/users/usersdb"
)

// Types of the exported queries.
type (
	BulkSetUserQuotaParams      = usersdb.BulkSetUserQuotaParams
	Device                      = usersdb.Device
	GetDeviceParams             = usersdb.GetDeviceParams
	GetUserBriefRow             = usersdb.GetUserBriefRow
	InsertProvisionedUserParams = usersdb.InsertProvisionedUserParams
	SearchDirectoryUsersParams  = usersdb.SearchDirectoryUsersParams
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

// SearchDirectoryUsers runs the SearchDirectoryUsers query on tx.
func SearchDirectoryUsers(ctx context.Context, tx db.DBTX, arg SearchDirectoryUsersParams) ([]SearchDirectoryUsersRow, error) {
	return usersdb.New(tx).SearchDirectoryUsers(ctx, arg)
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
