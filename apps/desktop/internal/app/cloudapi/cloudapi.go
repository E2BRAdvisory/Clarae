// Package cloudapi holds the DTOs of the cloud-management bindings (cloud vaults, devices, usage,
// sharing, directory): the OpenAPI types of shared/go/apiclient, field for field, with a `ts_type`
// tag where Wails cannot type a field by itself (UUIDs, timestamps, enums). The JSON is the one of
// the REST API, and the TypeScript models Wails generates are the Schemas of @memobrain/api-client
// (ADR-0045 §6), so the CloudPort of the core passes them through without mapping.
//
// Drift from api/openapi.yaml cannot go unnoticed:
//   - most types are converted from their apiclient type with a Go conversion (VaultOf, ...), which
//     compiles only while the two have the same fields, in the same order, of the same types;
//   - TestTypesMatchTheAPI compares every type with its apiclient type, JSON tags included;
//   - packages/workbench/src/cloud/bindingTypes.test.ts asserts that the generated TypeScript
//     models equal the Schemas (enums included), so `tsc` fails on a difference.
package cloudapi

import (
	"time"

	"github.com/google/uuid"

	"memobrain/shared/apiclient"
)

// Vault is a cloud vault of the account (OpenAPI Vault); DeletedAt is set on a soft-deleted one.
type Vault struct {
	CreatedAt  time.Time           `json:"created_at" ts_type:"string"`
	DeletedAt  *time.Time          `json:"deleted_at,omitempty" ts_type:"string"`
	FileCount  int                 `json:"file_count"`
	Id         uuid.UUID           `json:"id" ts_type:"string"`
	Kind       apiclient.VaultKind `json:"kind" ts_type:"'private' | 'shared'"`
	LastSeq    int64               `json:"last_seq"`
	Name       string              `json:"name"`
	OwnerId    uuid.UUID           `json:"owner_id" ts_type:"string"`
	TotalBytes int64               `json:"total_bytes"`
}

// VaultOf is the DTO of an API vault.
func VaultOf(v apiclient.Vault) Vault { return Vault(v) }

// VaultsOf is the DTO of a list of API vaults (an empty list, never nil).
func VaultsOf(vs []apiclient.Vault) []Vault {
	out := make([]Vault, 0, len(vs))
	for _, v := range vs {
		out = append(out, VaultOf(v))
	}
	return out
}

// Device is a registered device of the account (OpenAPI Device).
type Device struct {
	AppVersion *string    `json:"app_version,omitempty"`
	CreatedAt  time.Time  `json:"created_at" ts_type:"string"`
	Id         uuid.UUID  `json:"id" ts_type:"string"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty" ts_type:"string"`
	Name       string     `json:"name"`
	Platform   string     `json:"platform"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty" ts_type:"string"`
}

// AccountDevice is a Device as the core lists it: Current is set on the device the core runs on,
// which only the core knows (the console tells the component the id of its browser instead).
type AccountDevice struct {
	Device
	Current bool `json:"current"`
}

// DevicesOf is the DTO of the API devices; `current` is the id of this device ("" when unknown).
func DevicesOf(ds []apiclient.Device, current string) []AccountDevice {
	out := make([]AccountDevice, 0, len(ds))
	for _, d := range ds {
		out = append(out, AccountDevice{Device: Device(d), Current: current != "" && d.Id.String() == current})
	}
	return out
}

// Usage is the storage used by the account (OpenAPI Usage).
type Usage struct {
	Level      apiclient.UsageLevel `json:"level" ts_type:"'ok' | 'warning' | 'critical' | 'full'"`
	QuotaBytes int64                `json:"quota_bytes"`
	UsedBytes  int64                `json:"used_bytes"`
}

// UsageOf is the DTO of the API usage.
func UsageOf(u apiclient.Usage) Usage { return Usage(u) }

// Share is a share (OpenAPI Share): `my_permission` is absent for the owner of the vault, and
// `grants` are sent only to the owner and the managers.
type Share struct {
	CreatedAt    time.Time                  `json:"created_at" ts_type:"string"`
	DisplayName  string                     `json:"display_name"`
	ExpiresAt    *time.Time                 `json:"expires_at,omitempty" ts_type:"string"`
	FileId       *uuid.UUID                 `json:"file_id,omitempty" ts_type:"string"`
	Grants       *[]Grant                   `json:"grants,omitempty"`
	Id           uuid.UUID                  `json:"id" ts_type:"string"`
	MyPermission *apiclient.SharePermission `json:"my_permission,omitempty" ts_type:"'viewer' | 'editor' | 'manager'"`
	MyStatus     *apiclient.GrantStatus     `json:"my_status,omitempty" ts_type:"'pending' | 'accepted' | 'declined'"`
	OwnerId      uuid.UUID                  `json:"owner_id" ts_type:"string"`
	OwnerName    string                     `json:"owner_name"`
	PathPrefix   *string                    `json:"path_prefix,omitempty"`
	ResourceType apiclient.ResourceType     `json:"resource_type" ts_type:"'vault' | 'folder' | 'file'"`
	VaultId      uuid.UUID                  `json:"vault_id" ts_type:"string"`
	VaultName    string                     `json:"vault_name"`
}

// ShareOf is the DTO of an API share.
func ShareOf(s apiclient.Share) Share {
	out := Share{
		CreatedAt: s.CreatedAt, DisplayName: s.DisplayName, ExpiresAt: s.ExpiresAt, FileId: s.FileId,
		Id: s.Id, MyPermission: s.MyPermission, MyStatus: s.MyStatus, OwnerId: s.OwnerId, OwnerName: s.OwnerName,
		PathPrefix: s.PathPrefix, ResourceType: s.ResourceType, VaultId: s.VaultId, VaultName: s.VaultName,
	}
	if s.Grants != nil {
		gs := make([]Grant, 0, len(*s.Grants))
		for _, g := range *s.Grants {
			gs = append(gs, GrantOf(g))
		}
		out.Grants = &gs
	}
	return out
}

// SharesOf is the DTO of a list of API shares (an empty list, never nil).
func SharesOf(ss []apiclient.Share) []Share {
	out := make([]Share, 0, len(ss))
	for _, s := range ss {
		out = append(out, ShareOf(s))
	}
	return out
}

// Grant is a recipient of a share (OpenAPI Grant).
type Grant struct {
	CreatedAt     time.Time                    `json:"created_at" ts_type:"string"`
	GrantedBy     *uuid.UUID                   `json:"granted_by,omitempty" ts_type:"string"`
	Permission    apiclient.SharePermission    `json:"permission" ts_type:"'viewer' | 'editor' | 'manager'"`
	PrincipalId   uuid.UUID                    `json:"principal_id" ts_type:"string"`
	PrincipalName string                       `json:"principal_name"`
	PrincipalType apiclient.GrantPrincipalType `json:"principal_type" ts_type:"'user' | 'group'"`
	Status        apiclient.GrantStatus        `json:"status" ts_type:"'pending' | 'accepted' | 'declined'"`
}

// GrantOf is the DTO of an API grant.
func GrantOf(g apiclient.Grant) Grant { return Grant(g) }

// NewGrant is a recipient given while creating a share (OpenAPI NewGrant).
type NewGrant struct {
	Permission    apiclient.SharePermission       `json:"permission" ts_type:"'viewer' | 'editor' | 'manager'"`
	PrincipalId   uuid.UUID                       `json:"principal_id" ts_type:"string"`
	PrincipalType apiclient.NewGrantPrincipalType `json:"principal_type" ts_type:"'user' | 'group'"`
}

// API is the recipient as the API client takes it.
func (g NewGrant) API() apiclient.NewGrant { return apiclient.NewGrant(g) }

// UpdateShare is a change of a share (OpenAPI UpdateShare): a new name, a new expiry, or none.
type UpdateShare struct {
	ClearExpiry *bool      `json:"clear_expiry,omitempty"`
	DisplayName *string    `json:"display_name,omitempty"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty" ts_type:"string"`
}

// API is the change as the API client takes it.
func (u UpdateShare) API() apiclient.UpdateShare { return apiclient.UpdateShare(u) }

// DirectoryUser is a user found in the directory (OpenAPI DirectoryUser).
type DirectoryUser struct {
	DisplayName *string   `json:"display_name,omitempty"`
	Id          uuid.UUID `json:"id" ts_type:"string"`
	Username    string    `json:"username"`
}

// DirectoryUsersOf is the DTO of the API users (an empty list, never nil).
func DirectoryUsersOf(us []apiclient.DirectoryUser) []DirectoryUser {
	out := make([]DirectoryUser, 0, len(us))
	for _, u := range us {
		out = append(out, DirectoryUser(u))
	}
	return out
}

// DirectoryGroup is a group found in the directory (OpenAPI DirectoryGroup).
type DirectoryGroup struct {
	Description *string   `json:"description,omitempty"`
	Id          uuid.UUID `json:"id" ts_type:"string"`
	Name        string    `json:"name"`
}

// DirectoryGroupsOf is the DTO of the API groups (an empty list, never nil).
func DirectoryGroupsOf(gs []apiclient.DirectoryGroup) []DirectoryGroup {
	out := make([]DirectoryGroup, 0, len(gs))
	for _, g := range gs {
		out = append(out, DirectoryGroup(g))
	}
	return out
}
