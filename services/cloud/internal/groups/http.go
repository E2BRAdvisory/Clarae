package groups

import (
	"context"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
)

// HTTP implements the directory endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// ListMyGroups implements GET /me/groups.
func (h *HTTP) ListMyGroups(ctx context.Context, _ api.ListMyGroupsRequestObject) (api.ListMyGroupsResponseObject, error) {
	rows, err := h.svc.OfUser(ctx, auth.MustPrincipal(ctx).UserID)
	if err != nil {
		return nil, err
	}
	out := make([]api.GroupMembership, 0, len(rows))
	for _, r := range rows {
		out = append(out, api.GroupMembership{Id: r.ID, Name: r.Name, Description: r.Description, MemberRole: api.GroupMembershipMemberRole(r.MemberRole)})
	}
	return api.ListMyGroups200JSONResponse(out), nil
}

// SearchDirectoryUsers implements GET /directory/users.
func (h *HTTP) SearchDirectoryUsers(ctx context.Context, req api.SearchDirectoryUsersRequestObject) (api.SearchDirectoryUsersResponseObject, error) {
	rows, err := h.svc.SearchUsers(ctx, deref(req.Params.Q))
	if err != nil {
		return nil, err
	}
	out := make([]api.DirectoryUser, 0, len(rows))
	for _, r := range rows {
		out = append(out, api.DirectoryUser{Id: r.ID, Username: r.Username, DisplayName: r.DisplayName})
	}
	return api.SearchDirectoryUsers200JSONResponse(out), nil
}

// SearchDirectoryGroups implements GET /directory/groups.
func (h *HTTP) SearchDirectoryGroups(ctx context.Context, req api.SearchDirectoryGroupsRequestObject) (api.SearchDirectoryGroupsResponseObject, error) {
	rows, err := h.svc.SearchGroups(ctx, deref(req.Params.Q))
	if err != nil {
		return nil, err
	}
	out := make([]api.DirectoryGroup, 0, len(rows))
	for _, r := range rows {
		out = append(out, api.DirectoryGroup{Id: r.ID, Name: r.Name, Description: r.Description})
	}
	return api.SearchDirectoryGroups200JSONResponse(out), nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
