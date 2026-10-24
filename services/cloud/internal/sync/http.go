package sync

import (
	"context"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"nodus/services/cloud/internal/api"
	"nodus/services/cloud/internal/auth"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
)

// HTTP implements GET changes and POST commit of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// GetChanges implements GET /vaults/{vaultId}/changes.
func (h *HTTP) GetChanges(ctx context.Context, req api.GetChangesRequestObject) (api.GetChangesResponseObject, error) {
	if req.Params.Scope != nil && *req.Params.Scope != "" {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "scope is only available on shared mounts")
	}
	limit := 500
	if req.Params.Limit != nil {
		limit = *req.Params.Limit
	}
	items, next, more, err := h.svc.Changes(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, req.Params.Since, limit)
	if err != nil {
		return nil, err
	}
	out := make([]api.Change, 0, len(items))
	for _, c := range items {
		out = append(out, api.Change{
			Seq: c.Seq, FileId: c.FileID, Op: api.ChangeOp(c.Op), Path: c.Path, PrevPath: c.PrevPath, Rev: int(c.Rev),
			BlobHash: c.BlobHash, Size: c.Size, AuthorId: c.AuthorID, DeviceId: c.DeviceID, ServerTime: c.ServerTime, ConflictOf: c.ConflictOf,
		})
	}
	return api.GetChanges200JSONResponse{Items: out, NextSeq: next, HasMore: more}, nil
}

// Commit implements POST /vaults/{vaultId}/commit.
func (h *HTTP) Commit(ctx context.Context, req api.CommitRequestObject) (api.CommitResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	ops := make([]syncproto.Op, 0, len(req.Body.Ops))
	for _, o := range req.Body.Ops {
		ops = append(ops, fromAPIOp(o))
	}
	resp, err := h.svc.Commit(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, req.Body.DeviceId, ops)
	if err != nil {
		return nil, err
	}
	return api.Commit200JSONResponse(ToAPIResponse(resp)), nil
}

func fromAPIOp(o api.CommitOp) syncproto.Op {
	op := syncproto.Op{OpID: o.OpId.String(), Op: syncproto.OpKind(o.Op), BaseRev: o.BaseRev, ClientMtime: o.ClientMtime}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	op.Path, op.PathKey, op.BlobHash, op.From, op.To = str(o.Path), str(o.PathKey), str(o.BlobHash), str(o.From), str(o.To)
	if o.Size != nil {
		op.Size = *o.Size
	}
	if o.FileId != nil {
		op.FileID = o.FileId.String()
	}
	if o.ConflictOf != nil {
		op.ConflictOf = o.ConflictOf.String()
	}
	return op
}

// ToAPIResult converts one operation result.
func ToAPIResult(r syncproto.OpResult) api.OpResult {
	out := api.OpResult{Status: api.OpResultStatus(r.Status)}
	if id, err := parseUUID(r.OpID); err == nil {
		out.OpId = id
	}
	if id, err := parseUUID(r.FileID); err == nil && r.FileID != "" {
		out.FileId = &id
	}
	if r.Rev != 0 {
		out.Rev = &r.Rev
	}
	if r.Seq != 0 {
		out.Seq = &r.Seq
	}
	if r.Code != "" {
		c := api.ErrorCode(r.Code)
		out.Code = &c
	}
	if r.Detail != "" {
		out.Detail = &r.Detail
	}
	if r.CurrentRev != 0 {
		out.CurrentRev = &r.CurrentRev
	}
	if r.CurrentHash != "" {
		out.CurrentHash = &r.CurrentHash
	}
	if r.CurrentSeq != 0 {
		out.CurrentSeq = &r.CurrentSeq
	}
	return out
}

// ToAPIResponse converts a commit response.
func ToAPIResponse(r syncproto.CommitResponse) api.CommitResponse {
	out := api.CommitResponse{LastSeq: r.LastSeq, Results: make([]api.OpResult, 0, len(r.Results))}
	for _, x := range r.Results {
		out.Results = append(out.Results, ToAPIResult(x))
	}
	return out
}

func parseUUID(s string) (openapi_types.UUID, error) {
	var id openapi_types.UUID
	return id, id.UnmarshalText([]byte(s))
}

var _ = time.Time{}
