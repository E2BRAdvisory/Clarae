package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/configprofiles"
	"memobrain/services/cloud/internal/groups"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

// Groups is what the admin API needs from the groups module.
type Groups interface {
	Create(ctx context.Context, actor uuid.UUID, name, description string) (groups.Group, error)
	Update(ctx context.Context, actor, id uuid.UUID, name, description string) (groups.Group, error)
	Delete(ctx context.Context, actor, id uuid.UUID) error
	SetMember(ctx context.Context, actor, groupID, userID uuid.UUID, role string) error
	RemoveMember(ctx context.Context, actor, groupID, userID uuid.UUID) error
	Members(ctx context.Context, groupID uuid.UUID) ([]groups.ListGroupMembersRow, error)
}

// Profiles is what the admin API needs from the configuration module.
type Profiles interface {
	List(ctx context.Context) ([]configprofiles.ConfigProfile, error)
	Get(ctx context.Context, id uuid.UUID) (configprofiles.ConfigProfile, error)
	Create(ctx context.Context, actor uuid.UUID, in configprofiles.ProfileInput) (configprofiles.ConfigProfile, error)
	Update(ctx context.Context, actor, id uuid.UUID, in configprofiles.ProfileInput) (configprofiles.ConfigProfile, error)
	Delete(ctx context.Context, actor, id uuid.UUID) error
	Versions(ctx context.Context, id uuid.UUID) ([]configprofiles.ConfigProfileVersion, error)
	Restore(ctx context.Context, actor, id uuid.UUID, version int32) (configprofiles.ConfigProfile, error)
	SetGroupAssignments(ctx context.Context, actor, groupID uuid.UUID, as []configprofiles.Assignment) error
	EffectiveFor(ctx context.Context, userID uuid.UUID) (configprofiles.Effective, error)
}

// HTTP implements the /admin endpoints of the generated strict server. Every handler
// first requires the administrator role.
type HTTP struct {
	svc      *Service
	groups   Groups
	profiles Profiles
}

// NewHTTP binds the handlers.
func NewHTTP(s *Service, g Groups, p Profiles) *HTTP { return &HTTP{svc: s, groups: g, profiles: p} }

// admin returns the acting administrator or a FORBIDDEN problem.
func admin(ctx context.Context) (uuid.UUID, error) {
	p := auth.MustPrincipal(ctx)
	if !p.IsAdmin() {
		return uuid.Nil, httpproblem.Errorf(syncproto.CodeForbidden, "administrator role required")
	}
	return p.UserID, nil
}

func ptr[T comparable](v T) *T {
	var zero T
	if v == zero {
		return nil
	}
	return &v
}

func toAdminUser(v UserView) api.AdminUser {
	u := v.User
	return api.AdminUser{
		Id: u.ID, Username: u.Username, Email: u.Email, DisplayName: u.DisplayName, Role: api.Role(u.Role),
		Status: api.UserStatus(u.Status), QuotaBytesOverride: u.QuotaBytesOverride, QuotaBytes: v.QuotaBytes,
		UsedBytes: u.UsedBytes, CreatedAt: u.CreatedAt, LastLoginAt: u.LastLoginAt,
	}
}

// AdminListUsers implements GET /admin/users.
func (h *HTTP) AdminListUsers(ctx context.Context, req api.AdminListUsersRequestObject) (api.AdminListUsersResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	p := req.Params
	f := UserFilter{Group: p.Group}
	if p.Q != nil {
		f.Query = *p.Q
	}
	if p.Status != nil {
		f.Status = *p.Status
	}
	if p.Role != nil {
		f.Role = *p.Role
	}
	if p.Sort != nil {
		f.Sort = *p.Sort
	}
	if p.Limit != nil {
		f.Limit = *p.Limit
	}
	if p.Offset != nil {
		f.Offset = *p.Offset
	}
	users, total, err := h.svc.ListUsers(ctx, f)
	if err != nil {
		return nil, err
	}
	items := make([]api.AdminUser, 0, len(users))
	for _, u := range users {
		items = append(items, toAdminUser(u))
	}
	return api.AdminListUsers200JSONResponse{Items: items, Total: total}, nil
}

// AdminCreateUser implements POST /admin/users.
func (h *HTTP) AdminCreateUser(ctx context.Context, req api.AdminCreateUserRequestObject) (api.AdminCreateUserResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	b := req.Body
	if b == nil {
		return nil, bad("body required")
	}
	in := NewUser{Username: b.Username, Email: string(b.Email), DisplayName: deref(b.DisplayName), TemporaryPassword: deref(b.TemporaryPassword)}
	if b.Role != nil {
		in.Role = string(*b.Role)
	}
	u, err := h.svc.CreateUser(ctx, actor, in)
	if err != nil {
		return nil, err
	}
	return api.AdminCreateUser201JSONResponse(toAdminUser(u)), nil
}

// AdminGetUser implements GET /admin/users/{userId}.
func (h *HTTP) AdminGetUser(ctx context.Context, req api.AdminGetUserRequestObject) (api.AdminGetUserResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	u, err := h.svc.GetUser(ctx, req.UserId)
	if err != nil {
		return nil, err
	}
	return api.AdminGetUser200JSONResponse(toAdminUser(u)), nil
}

// AdminUpdateUser implements PATCH /admin/users/{userId}.
func (h *HTTP) AdminUpdateUser(ctx context.Context, req api.AdminUpdateUserRequestObject) (api.AdminUpdateUserResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	var email *string
	if req.Body.Email != nil {
		e := string(*req.Body.Email)
		email = &e
	}
	u, err := h.svc.UpdateUser(ctx, actor, req.UserId, req.Body.DisplayName, email)
	if err != nil {
		return nil, err
	}
	return api.AdminUpdateUser200JSONResponse(toAdminUser(u)), nil
}

// AdminDeleteUser implements DELETE /admin/users/{userId}.
func (h *HTTP) AdminDeleteUser(ctx context.Context, req api.AdminDeleteUserRequestObject) (api.AdminDeleteUserResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.Delete(ctx, actor, req.UserId); err != nil {
		return nil, err
	}
	return api.AdminDeleteUser204Response{}, nil
}

// AdminSuspendUser implements POST /admin/users/{userId}:suspend.
func (h *HTTP) AdminSuspendUser(ctx context.Context, req api.AdminSuspendUserRequestObject) (api.AdminSuspendUserResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	u, err := h.svc.Suspend(ctx, actor, req.UserId)
	if err != nil {
		return nil, err
	}
	return api.AdminSuspendUser200JSONResponse(toAdminUser(u)), nil
}

// AdminActivateUser implements POST /admin/users/{userId}:activate.
func (h *HTTP) AdminActivateUser(ctx context.Context, req api.AdminActivateUserRequestObject) (api.AdminActivateUserResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	u, err := h.svc.Activate(ctx, actor, req.UserId)
	if err != nil {
		return nil, err
	}
	return api.AdminActivateUser200JSONResponse(toAdminUser(u)), nil
}

// AdminResetPassword implements POST /admin/users/{userId}:reset-password.
func (h *HTTP) AdminResetPassword(ctx context.Context, req api.AdminResetPasswordRequestObject) (api.AdminResetPasswordResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	sent, err := h.svc.ResetPassword(ctx, actor, req.UserId)
	if err != nil {
		return nil, err
	}
	return api.AdminResetPassword200JSONResponse{EmailSent: sent}, nil
}

// AdminSetUserRole implements PUT /admin/users/{userId}/role.
func (h *HTTP) AdminSetUserRole(ctx context.Context, req api.AdminSetUserRoleRequestObject) (api.AdminSetUserRoleResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	u, err := h.svc.SetRole(ctx, actor, req.UserId, string(req.Body.Role))
	if err != nil {
		return nil, err
	}
	return api.AdminSetUserRole200JSONResponse(toAdminUser(u)), nil
}

// AdminSetUserQuota implements PUT /admin/users/{userId}/quota.
func (h *HTTP) AdminSetUserQuota(ctx context.Context, req api.AdminSetUserQuotaRequestObject) (api.AdminSetUserQuotaResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	u, err := h.svc.SetQuota(ctx, actor, req.UserId, req.Body.QuotaBytes)
	if err != nil {
		return nil, err
	}
	return api.AdminSetUserQuota200JSONResponse(toAdminUser(u)), nil
}

// AdminListUserVaults implements GET /admin/users/{userId}/vaults.
func (h *HTTP) AdminListUserVaults(ctx context.Context, req api.AdminListUserVaultsRequestObject) (api.AdminListUserVaultsResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.svc.Vaults(ctx, req.UserId)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminListUserVaults200JSONResponse, 0, len(rows))
	for _, r := range rows {
		out = append(out, api.AdminVault{
			Id: r.ID, Name: r.Name, Kind: api.VaultKind(r.Kind), TotalBytes: r.TotalBytes, FileCount: int(r.FileCount),
			CreatedAt: r.CreatedAt, DeletedAt: r.DeletedAt,
		})
	}
	return out, nil
}

// AdminListUserDevices implements GET /admin/users/{userId}/devices.
func (h *HTTP) AdminListUserDevices(ctx context.Context, req api.AdminListUserDevicesRequestObject) (api.AdminListUserDevicesResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.svc.Devices(ctx, req.UserId)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminListUserDevices200JSONResponse, 0, len(rows))
	for _, d := range rows {
		out = append(out, api.Device{
			Id: d.ID, Name: d.Name, Platform: d.Platform, AppVersion: d.AppVersion, CreatedAt: d.CreatedAt,
			LastSeenAt: d.LastSeenAt, RevokedAt: d.RevokedAt,
		})
	}
	return out, nil
}

// AdminListUserSessions implements GET /admin/users/{userId}/sessions.
func (h *HTTP) AdminListUserSessions(ctx context.Context, req api.AdminListUserSessionsRequestObject) (api.AdminListUserSessionsResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.svc.Sessions(ctx, req.UserId)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminListUserSessions200JSONResponse, 0, len(rows))
	for _, s := range rows {
		us := api.UserSession{Id: s.ID, IpAddress: ptr(s.IPAddress), Started: s.Started, LastAccess: s.LastAccess}
		if len(s.Clients) > 0 {
			c := s.Clients
			us.Clients = &c
		}
		out = append(out, us)
	}
	return out, nil
}

// AdminUserEffectiveConfig implements GET /admin/users/{userId}/config/effective.
func (h *HTTP) AdminUserEffectiveConfig(ctx context.Context, req api.AdminUserEffectiveConfigRequestObject) (api.AdminUserEffectiveConfigResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	if _, err := h.svc.GetUser(ctx, req.UserId); err != nil {
		return nil, err
	}
	eff, err := h.profiles.EffectiveFor(ctx, req.UserId)
	if err != nil {
		return nil, err
	}
	return api.AdminUserEffectiveConfig200JSONResponse{Version: int(eff.Version), Config: eff.Config, LockedKeys: eff.LockedKeys}, nil
}

// AdminListGroups implements GET /admin/groups.
func (h *HTTP) AdminListGroups(ctx context.Context, _ api.AdminListGroupsRequestObject) (api.AdminListGroupsResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.svc.Groups(ctx)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminListGroups200JSONResponse, 0, len(rows))
	for _, g := range rows {
		out = append(out, api.AdminGroup{Id: g.ID, Name: g.Name, Description: g.Description, MemberCount: int(g.MemberCount), CreatedAt: g.CreatedAt})
	}
	return out, nil
}

func (h *HTTP) groupView(ctx context.Context, id uuid.UUID) (api.AdminGroup, error) {
	g, err := h.svc.Group(ctx, id)
	if err != nil {
		return api.AdminGroup{}, err
	}
	return api.AdminGroup{Id: g.ID, Name: g.Name, Description: g.Description, MemberCount: int(g.MemberCount), CreatedAt: g.CreatedAt}, nil
}

// AdminCreateGroup implements POST /admin/groups.
func (h *HTTP) AdminCreateGroup(ctx context.Context, req api.AdminCreateGroupRequestObject) (api.AdminCreateGroupResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	g, err := h.groups.Create(ctx, actor, req.Body.Name, deref(req.Body.Description))
	if err != nil {
		return nil, err
	}
	v, err := h.groupView(ctx, g.ID)
	if err != nil {
		return nil, err
	}
	return api.AdminCreateGroup201JSONResponse(v), nil
}

// AdminGetGroup implements GET /admin/groups/{groupId}.
func (h *HTTP) AdminGetGroup(ctx context.Context, req api.AdminGetGroupRequestObject) (api.AdminGetGroupResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	v, err := h.groupView(ctx, req.GroupId)
	if err != nil {
		return nil, err
	}
	return api.AdminGetGroup200JSONResponse(v), nil
}

// AdminUpdateGroup implements PATCH /admin/groups/{groupId}.
func (h *HTTP) AdminUpdateGroup(ctx context.Context, req api.AdminUpdateGroupRequestObject) (api.AdminUpdateGroupResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	if _, err := h.groups.Update(ctx, actor, req.GroupId, req.Body.Name, deref(req.Body.Description)); err != nil {
		return nil, err
	}
	v, err := h.groupView(ctx, req.GroupId)
	if err != nil {
		return nil, err
	}
	return api.AdminUpdateGroup200JSONResponse(v), nil
}

// AdminDeleteGroup implements DELETE /admin/groups/{groupId}.
func (h *HTTP) AdminDeleteGroup(ctx context.Context, req api.AdminDeleteGroupRequestObject) (api.AdminDeleteGroupResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.groups.Delete(ctx, actor, req.GroupId); err != nil {
		return nil, err
	}
	return api.AdminDeleteGroup204Response{}, nil
}

// AdminListGroupMembers implements GET /admin/groups/{groupId}/members.
func (h *HTTP) AdminListGroupMembers(ctx context.Context, req api.AdminListGroupMembersRequestObject) (api.AdminListGroupMembersResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	if _, err := h.svc.Group(ctx, req.GroupId); err != nil {
		return nil, err
	}
	rows, err := h.groups.Members(ctx, req.GroupId)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminListGroupMembers200JSONResponse, 0, len(rows))
	for _, m := range rows {
		email := m.Email
		out = append(out, api.GroupMember{
			UserId: m.ID, Username: m.Username, Email: &email, DisplayName: m.DisplayName,
			MemberRole: api.GroupMemberMemberRole(m.MemberRole),
		})
	}
	return out, nil
}

// AdminSetGroupMember implements PUT /admin/groups/{groupId}/members/{userId}.
func (h *HTTP) AdminSetGroupMember(ctx context.Context, req api.AdminSetGroupMemberRequestObject) (api.AdminSetGroupMemberResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	if err := h.groups.SetMember(ctx, actor, req.GroupId, req.UserId, string(req.Body.MemberRole)); err != nil {
		return nil, err
	}
	return api.AdminSetGroupMember204Response{}, nil
}

// AdminRemoveGroupMember implements DELETE /admin/groups/{groupId}/members/{userId}.
func (h *HTTP) AdminRemoveGroupMember(ctx context.Context, req api.AdminRemoveGroupMemberRequestObject) (api.AdminRemoveGroupMemberResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.groups.RemoveMember(ctx, actor, req.GroupId, req.UserId); err != nil {
		return nil, err
	}
	return api.AdminRemoveGroupMember204Response{}, nil
}

// AdminGetGroupProfiles implements GET /admin/groups/{groupId}/config-profiles.
func (h *HTTP) AdminGetGroupProfiles(ctx context.Context, req api.AdminGetGroupProfilesRequestObject) (api.AdminGetGroupProfilesResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.svc.GroupAssignments(ctx, req.GroupId)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminGetGroupProfiles200JSONResponse, 0, len(rows))
	for _, a := range rows {
		out = append(out, api.ProfileAssignment{ProfileId: a.ProfileID, Priority: int(a.Priority)})
	}
	return out, nil
}

// AdminSetGroupProfiles implements PUT /admin/groups/{groupId}/config-profiles.
func (h *HTTP) AdminSetGroupProfiles(ctx context.Context, req api.AdminSetGroupProfilesRequestObject) (api.AdminSetGroupProfilesResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	as := make([]configprofiles.Assignment, 0, len(req.Body.Items))
	for _, it := range req.Body.Items {
		as = append(as, configprofiles.Assignment{ProfileID: it.ProfileId, Priority: clampInt32(it.Priority)})
	}
	if err := h.profiles.SetGroupAssignments(ctx, actor, req.GroupId, as); err != nil {
		return nil, err
	}
	return api.AdminSetGroupProfiles204Response{}, nil
}

func decodeConfig(raw []byte) map[string]any {
	m := map[string]any{}
	_ = json.Unmarshal(raw, &m)
	return m
}

func toProfile(p configprofiles.ConfigProfile) api.ConfigProfile {
	locked := p.LockedKeys
	if locked == nil {
		locked = []string{}
	}
	return api.ConfigProfile{
		Id: p.ID, Name: p.Name, Description: p.Description, IsGlobal: p.IsGlobal, Version: int(p.Version),
		Config: decodeConfig(p.Config), LockedKeys: locked, UpdatedBy: p.UpdatedBy, UpdatedAt: p.UpdatedAt,
	}
}

func profileInput(b *api.ConfigProfileInput) (configprofiles.ProfileInput, error) {
	if b == nil {
		return configprofiles.ProfileInput{}, bad("body required")
	}
	raw, err := json.Marshal(b.Config)
	if err != nil {
		return configprofiles.ProfileInput{}, bad("config is not valid JSON")
	}
	in := configprofiles.ProfileInput{Name: b.Name, Description: deref(b.Description), Config: bytes.Clone(raw)}
	if b.IsGlobal != nil {
		in.IsGlobal = *b.IsGlobal
	}
	if b.LockedKeys != nil {
		in.LockedKeys = *b.LockedKeys
	}
	return in, nil
}

// AdminListConfigProfiles implements GET /admin/config-profiles.
func (h *HTTP) AdminListConfigProfiles(ctx context.Context, _ api.AdminListConfigProfilesRequestObject) (api.AdminListConfigProfilesResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.profiles.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminListConfigProfiles200JSONResponse, 0, len(rows))
	for _, p := range rows {
		out = append(out, toProfile(p))
	}
	return out, nil
}

// AdminCreateConfigProfile implements POST /admin/config-profiles.
func (h *HTTP) AdminCreateConfigProfile(ctx context.Context, req api.AdminCreateConfigProfileRequestObject) (api.AdminCreateConfigProfileResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	in, err := profileInput(req.Body)
	if err != nil {
		return nil, err
	}
	p, err := h.profiles.Create(ctx, actor, in)
	if err != nil {
		return nil, err
	}
	return api.AdminCreateConfigProfile201JSONResponse(toProfile(p)), nil
}

// AdminGetConfigProfile implements GET /admin/config-profiles/{profileId}.
func (h *HTTP) AdminGetConfigProfile(ctx context.Context, req api.AdminGetConfigProfileRequestObject) (api.AdminGetConfigProfileResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	p, err := h.profiles.Get(ctx, req.ProfileId)
	if err != nil {
		return nil, err
	}
	return api.AdminGetConfigProfile200JSONResponse(toProfile(p)), nil
}

// AdminUpdateConfigProfile implements PUT /admin/config-profiles/{profileId}.
func (h *HTTP) AdminUpdateConfigProfile(ctx context.Context, req api.AdminUpdateConfigProfileRequestObject) (api.AdminUpdateConfigProfileResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	in, err := profileInput(req.Body)
	if err != nil {
		return nil, err
	}
	p, err := h.profiles.Update(ctx, actor, req.ProfileId, in)
	if err != nil {
		return nil, err
	}
	return api.AdminUpdateConfigProfile200JSONResponse(toProfile(p)), nil
}

// AdminDeleteConfigProfile implements DELETE /admin/config-profiles/{profileId}.
func (h *HTTP) AdminDeleteConfigProfile(ctx context.Context, req api.AdminDeleteConfigProfileRequestObject) (api.AdminDeleteConfigProfileResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.profiles.Delete(ctx, actor, req.ProfileId); err != nil {
		return nil, err
	}
	return api.AdminDeleteConfigProfile204Response{}, nil
}

// AdminListProfileVersions implements GET /admin/config-profiles/{profileId}/versions.
func (h *HTTP) AdminListProfileVersions(ctx context.Context, req api.AdminListProfileVersionsRequestObject) (api.AdminListProfileVersionsResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.profiles.Versions(ctx, req.ProfileId)
	if err != nil {
		return nil, err
	}
	out := make(api.AdminListProfileVersions200JSONResponse, 0, len(rows))
	for _, v := range rows {
		locked := v.LockedKeys
		if locked == nil {
			locked = []string{}
		}
		out = append(out, api.ProfileVersion{
			Version: int(v.Version), Name: v.Name, Description: v.Description, IsGlobal: v.IsGlobal,
			Config: decodeConfig(v.Config), LockedKeys: locked, UpdatedBy: v.UpdatedBy, UpdatedAt: v.UpdatedAt,
		})
	}
	return out, nil
}

// AdminRestoreProfileVersion implements POST /admin/config-profiles/{profileId}/versions/{version}:restore.
func (h *HTTP) AdminRestoreProfileVersion(ctx context.Context, req api.AdminRestoreProfileVersionRequestObject) (api.AdminRestoreProfileVersionResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	p, err := h.profiles.Restore(ctx, actor, req.ProfileId, clampInt32(req.Version))
	if err != nil {
		return nil, err
	}
	return api.AdminRestoreProfileVersion200JSONResponse(toProfile(p)), nil
}

func toStorageSettings(s StorageSettings) api.StorageSettings {
	return api.StorageSettings{
		DefaultQuotaBytes: s.DefaultQuotaBytes, WarnPercent: s.WarnPercent, CriticalPercent: s.CriticalPercent,
		HistoryRetentionDays: s.HistoryRetentionDays, HistoryDailyRetentionDays: s.HistoryDailyRetentionDays,
		MaxFileSizeBytes: s.MaxFileSizeBytes,
	}
}

// AdminGetStorageSettings implements GET /admin/settings/storage.
func (h *HTTP) AdminGetStorageSettings(ctx context.Context, _ api.AdminGetStorageSettingsRequestObject) (api.AdminGetStorageSettingsResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	s, err := h.svc.StorageSettings(ctx)
	if err != nil {
		return nil, err
	}
	return api.AdminGetStorageSettings200JSONResponse(toStorageSettings(s)), nil
}

// AdminPutStorageSettings implements PUT /admin/settings/storage.
func (h *HTTP) AdminPutStorageSettings(ctx context.Context, req api.AdminPutStorageSettingsRequestObject) (api.AdminPutStorageSettingsResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	b := req.Body
	if b == nil {
		return nil, bad("body required")
	}
	s, err := h.svc.PutStorageSettings(ctx, actor, StorageSettings{
		DefaultQuotaBytes: b.DefaultQuotaBytes, WarnPercent: b.WarnPercent, CriticalPercent: b.CriticalPercent,
		HistoryRetentionDays: b.HistoryRetentionDays, HistoryDailyRetentionDays: b.HistoryDailyRetentionDays,
		MaxFileSizeBytes: b.MaxFileSizeBytes,
	})
	if err != nil {
		return nil, err
	}
	return api.AdminPutStorageSettings200JSONResponse(toStorageSettings(s)), nil
}

// AdminStorageOverview implements GET /admin/storage/overview.
func (h *HTTP) AdminStorageOverview(ctx context.Context, _ api.AdminStorageOverviewRequestObject) (api.AdminStorageOverviewResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	o, err := h.svc.StorageOverview(ctx)
	if err != nil {
		return nil, err
	}
	top := make([]api.TopConsumer, 0, len(o.Top))
	for _, t := range o.Top {
		top = append(top, api.TopConsumer{UserId: t.ID, Username: t.Username, UsedBytes: t.UsedBytes, QuotaBytes: t.QuotaBytes})
	}
	trend := make([]api.TrendPoint, 0, len(o.Trend))
	for _, t := range o.Trend {
		trend = append(trend, api.TrendPoint{Day: openapi_types.Date{Time: t.Day.Time}, TotalBytes: t.TotalBytes})
	}
	return api.AdminStorageOverview200JSONResponse{
		DefaultQuotaBytes: o.DefaultQuotaBytes, TotalUsedBytes: o.TotalUsedBytes, UserCount: o.UserCount,
		UsersOverWarn: o.OverWarn, UsersOverCritical: o.OverCritical, TopConsumers: top, Trend: trend,
	}, nil
}

// AdminBulkQuota implements POST /admin/storage/bulk-quota.
func (h *HTTP) AdminBulkQuota(ctx context.Context, req api.AdminBulkQuotaRequestObject) (api.AdminBulkQuotaResponseObject, error) {
	actor, err := admin(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, bad("body required")
	}
	n, err := h.svc.BulkQuota(ctx, actor, req.Body.UserIds, req.Body.QuotaBytes)
	if err != nil {
		return nil, err
	}
	return api.AdminBulkQuota200JSONResponse{Updated: n}, nil
}

func filterOf(actor *openapi_types.UUID, action, target *string, from, to *time.Time) AuditFilter {
	f := AuditFilter{Actor: actor, Action: deref(action), Target: deref(target), From: from, To: to}
	return f
}

// AdminAuditLog implements GET /admin/audit-log.
func (h *HTTP) AdminAuditLog(ctx context.Context, req api.AdminAuditLogRequestObject) (api.AdminAuditLogResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	p := req.Params
	limit := 0
	if p.Limit != nil {
		limit = *p.Limit
	}
	rows, next, err := h.svc.AuditPage(ctx, filterOf(p.Actor, p.Action, p.Target, p.From, p.To), limit, deref(p.Cursor))
	if err != nil {
		return nil, err
	}
	items := make([]api.AuditEntry, 0, len(rows))
	for _, r := range rows {
		e := api.AuditEntry{
			Id: r.ID, At: r.At, ActorId: r.ActorID, ActorName: r.ActorName, Action: r.Action,
			TargetType: r.TargetType, TargetId: r.TargetID, Ip: ptr(r.Ip),
		}
		if len(r.Details) > 0 {
			d := decodeConfig(r.Details)
			e.Details = &d
		}
		items = append(items, e)
	}
	return api.AdminAuditLog200JSONResponse{Items: items, NextCursor: ptr(next)}, nil
}

// AdminAuditLogCsv implements GET /admin/audit-log.csv.
func (h *HTTP) AdminAuditLogCsv(ctx context.Context, req api.AdminAuditLogCsvRequestObject) (api.AdminAuditLogCsvResponseObject, error) {
	if _, err := admin(ctx); err != nil {
		return nil, err
	}
	p := req.Params
	b, err := h.svc.AuditCSV(ctx, filterOf(p.Actor, p.Action, p.Target, p.From, p.To))
	if err != nil {
		return nil, err
	}
	return api.AdminAuditLogCsv200TextcsvResponse{Body: bytes.NewReader(b), ContentLength: int64(len(b))}, nil
}
