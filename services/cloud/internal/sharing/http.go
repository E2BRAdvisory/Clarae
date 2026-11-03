package sharing

import (
	"context"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/pagination"
	"memobrain/services/cloud/internal/sharing/sharingdb"
	"memobrain/shared/syncproto"
)

// HTTP implements the sharing endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

func toGrant(g sharingdb.ListGrantsRow) api.Grant {
	out := api.Grant{
		CreatedAt: g.CreatedAt, Permission: api.SharePermission(g.Permission), PrincipalId: g.PrincipalID,
		PrincipalName: g.PrincipalName, PrincipalType: api.GrantPrincipalType(g.PrincipalType), Status: api.GrantStatus(g.Status),
	}
	by := g.GrantedBy
	out.GrantedBy = &by
	return out
}

func toShare(v View) api.Share {
	sh := v.Share
	out := api.Share{
		Id: sh.ID, VaultId: sh.VaultID, VaultName: v.VaultName, ResourceType: api.ResourceType(sh.ResourceType),
		DisplayName: sh.DisplayName, OwnerId: v.OwnerID, OwnerName: v.OwnerName, CreatedAt: sh.CreatedAt, ExpiresAt: sh.ExpiresAt,
	}
	if v.canManage() {
		out.PathPrefix = sh.PathPrefix // folders are internal detail for recipients
		out.FileId = sh.FileID
		grants := make([]api.Grant, 0, len(v.Grants))
		for _, g := range v.Grants {
			grants = append(grants, toGrant(g))
		}
		out.Grants = &grants
	}
	if v.IsOwner {
		p := api.SharePermission(access.Manager.String())
		out.MyPermission = &p
	} else {
		if v.MyPermission != access.None {
			p := api.SharePermission(v.MyPermission.String())
			out.MyPermission = &p
		}
		if v.MyStatus != "" { // a declined invitation has no level but still a status
			st := api.GrantStatus(v.MyStatus)
			out.MyStatus = &st
		}
	}
	return out
}

func toShares(vs []View) []api.Share {
	out := make([]api.Share, 0, len(vs))
	for _, v := range vs {
		out = append(out, toShare(v))
	}
	return out
}

func grantsOf(in *[]api.NewGrant) []NewGrant {
	if in == nil {
		return nil
	}
	out := make([]NewGrant, 0, len(*in))
	for _, g := range *in {
		out = append(out, NewGrant{PrincipalType: string(g.PrincipalType), PrincipalID: g.PrincipalId, Permission: access.ParsePermission(string(g.Permission))})
	}
	return out
}

// ListShares implements GET /shares.
func (h *HTTP) ListShares(ctx context.Context, req api.ListSharesRequestObject) (api.ListSharesResponseObject, error) {
	user := auth.MustPrincipal(ctx).UserID
	var (
		vs  []View
		err error
	)
	limit := pagination.Limit(req.Params.Limit, pagination.DefaultLimit, pagination.MaxLimit)
	cursor := ""
	if req.Params.Cursor != nil {
		cursor = *req.Params.Cursor
	}
	var next *string
	switch req.Params.Scope {
	case api.Owned:
		vs, next, err = h.svc.ListOwned(ctx, user, limit, cursor)
	case api.Received:
		vs, next, err = h.svc.ListReceived(ctx, user, limit, cursor)
	default:
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "scope must be owned or received")
	}
	if err != nil {
		return nil, err
	}
	return api.ListShares200JSONResponse{Items: toShares(vs), NextCursor: next}, nil
}

// CreateShare implements POST /shares.
func (h *HTTP) CreateShare(ctx context.Context, req api.CreateShareRequestObject) (api.CreateShareResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	b := req.Body
	in := CreateInput{VaultID: b.VaultId, ResourceType: string(b.ResourceType), DisplayName: b.DisplayName, ExpiresAt: b.ExpiresAt, Grants: grantsOf(b.Grants)}
	if b.PathPrefix != nil {
		in.PathPrefix = *b.PathPrefix
	}
	if b.FileId != nil {
		in.FileID = *b.FileId
	}
	v, err := h.svc.Create(ctx, auth.MustPrincipal(ctx).UserID, in)
	if err != nil {
		return nil, err
	}
	return api.CreateShare201JSONResponse(toShare(v)), nil
}

// GetShare implements GET /shares/{shareId}.
func (h *HTTP) GetShare(ctx context.Context, req api.GetShareRequestObject) (api.GetShareResponseObject, error) {
	v, err := h.svc.Get(ctx, auth.MustPrincipal(ctx).UserID, req.ShareId)
	if err != nil {
		return nil, err
	}
	return api.GetShare200JSONResponse(toShare(v)), nil
}

// UpdateShare implements PATCH /shares/{shareId}.
func (h *HTTP) UpdateShare(ctx context.Context, req api.UpdateShareRequestObject) (api.UpdateShareResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	in := UpdateInput{DisplayName: req.Body.DisplayName, ExpiresAt: req.Body.ExpiresAt}
	if req.Body.ClearExpiry != nil {
		in.ClearExpiry = *req.Body.ClearExpiry
	}
	v, err := h.svc.Update(ctx, auth.MustPrincipal(ctx).UserID, req.ShareId, in)
	if err != nil {
		return nil, err
	}
	return api.UpdateShare200JSONResponse(toShare(v)), nil
}

// RevokeShare implements DELETE /shares/{shareId}.
func (h *HTTP) RevokeShare(ctx context.Context, req api.RevokeShareRequestObject) (api.RevokeShareResponseObject, error) {
	if err := h.svc.Revoke(ctx, auth.MustPrincipal(ctx).UserID, req.ShareId); err != nil {
		return nil, err
	}
	return api.RevokeShare204Response{}, nil
}

// PutGrant implements PUT /shares/{shareId}/grants/{principalType}/{principalId}.
func (h *HTTP) PutGrant(ctx context.Context, req api.PutGrantRequestObject) (api.PutGrantResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	g, err := h.svc.PutGrant(ctx, auth.MustPrincipal(ctx).UserID, req.ShareId,
		NewGrant{PrincipalType: string(req.PrincipalType), PrincipalID: req.PrincipalId, Permission: access.ParsePermission(string(req.Body.Permission))})
	if err != nil {
		return nil, err
	}
	return api.PutGrant200JSONResponse(toGrant(g)), nil
}

// DeleteGrant implements DELETE /shares/{shareId}/grants/{principalType}/{principalId}.
func (h *HTTP) DeleteGrant(ctx context.Context, req api.DeleteGrantRequestObject) (api.DeleteGrantResponseObject, error) {
	if err := h.svc.DeleteGrant(ctx, auth.MustPrincipal(ctx).UserID, req.ShareId, string(req.PrincipalType), req.PrincipalId); err != nil {
		return nil, err
	}
	return api.DeleteGrant204Response{}, nil
}

// AcceptShare implements POST /shares/{shareId}:accept.
func (h *HTTP) AcceptShare(ctx context.Context, req api.AcceptShareRequestObject) (api.AcceptShareResponseObject, error) {
	v, err := h.svc.Accept(ctx, auth.MustPrincipal(ctx).UserID, req.ShareId)
	if err != nil {
		return nil, err
	}
	return api.AcceptShare200JSONResponse(toShare(v)), nil
}

// DeclineShare implements POST /shares/{shareId}:decline.
func (h *HTTP) DeclineShare(ctx context.Context, req api.DeclineShareRequestObject) (api.DeclineShareResponseObject, error) {
	v, err := h.svc.Decline(ctx, auth.MustPrincipal(ctx).UserID, req.ShareId)
	if err != nil {
		return nil, err
	}
	return api.DeclineShare200JSONResponse(toShare(v)), nil
}

// ListSharedWithMe implements GET /shared-with-me.
func (h *HTTP) ListSharedWithMe(ctx context.Context, req api.ListSharedWithMeRequestObject) (api.ListSharedWithMeResponseObject, error) {
	limit := pagination.Limit(req.Params.Limit, pagination.DefaultLimit, pagination.MaxLimit)
	cursor := ""
	if req.Params.Cursor != nil {
		cursor = *req.Params.Cursor
	}
	ms, next, err := h.svc.SharedWithMe(ctx, auth.MustPrincipal(ctx).UserID, limit, cursor)
	if err != nil {
		return nil, err
	}
	out := make([]api.Mount, 0, len(ms))
	for _, m := range ms {
		out = append(out, api.Mount{
			ShareId: m.ShareID, VaultId: m.VaultID, DisplayName: m.DisplayName, ResourceType: api.ResourceType(m.ResourceType),
			Permission: api.SharePermission(m.Permission.String()), Scope: m.Scope(), OwnerName: m.OwnerName, ExpiresAt: m.ExpiresAt,
		})
	}
	return api.ListSharedWithMe200JSONResponse{Items: out, NextCursor: next}, nil
}
