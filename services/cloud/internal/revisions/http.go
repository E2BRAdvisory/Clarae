package revisions

import (
	"context"
	"io"
	"math"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/api"
	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/revisions/revisionsdb"
	syncmod "clarae/services/cloud/internal/sync"
)

// HTTP implements the history endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

func toAPI(r revisionsdb.FileRevision) api.Revision {
	return api.Revision{
		Rev: int(r.RevNo), Seq: r.Seq, Op: api.ChangeOp(r.Op), Path: r.Path, PrevPath: r.PrevPath, BlobHash: r.BlobHash,
		Size: r.Size, AuthorId: r.AuthorID, DeviceId: r.DeviceID, ServerTime: r.ServerTime,
	}
}

// ListRevisions implements GET /vaults/{vaultId}/files/{fileId}/revisions.
func (h *HTTP) ListRevisions(ctx context.Context, req api.ListRevisionsRequestObject) (api.ListRevisionsResponseObject, error) {
	limit, cursor := 100, ""
	if req.Params.Limit != nil {
		limit = *req.Params.Limit
	}
	if req.Params.Cursor != nil {
		cursor = *req.Params.Cursor
	}
	rows, next, err := h.svc.List(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, scopeOf(req.Params.Scope), req.FileId, limit, cursor)
	if err != nil {
		return nil, err
	}
	items := make([]api.Revision, 0, len(rows))
	for _, r := range rows {
		items = append(items, toAPI(r))
	}
	out := api.ListRevisions200JSONResponse{Items: items}
	if next != "" {
		out.NextCursor = &next
	}
	return out, nil
}

// GetRevisionContent implements GET .../revisions/{rev}/content.
func (h *HTTP) GetRevisionContent(ctx context.Context, req api.GetRevisionContentRequestObject) (api.GetRevisionContentResponseObject, error) {
	rc, size, err := h.svc.Content(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, scopeOf(req.Params.Scope), req.FileId, clampInt32(req.Rev))
	if err != nil {
		return nil, err
	}
	return api.GetRevisionContent200ApplicationoctetStreamResponse{Body: io.Reader(rc), ContentLength: size}, nil
}

// RestoreRevision implements POST .../revisions/{rev}:restore.
func (h *HTTP) RestoreRevision(ctx context.Context, req api.RestoreRevisionRequestObject) (api.RestoreRevisionResponseObject, error) {
	opID, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	if k := req.Params.IdempotencyKey; k != nil && *k != "" {
		// A retry with the same key must land on the same operation id.
		opID = uuid.NewSHA1(uuid.NameSpaceOID, []byte(req.VaultId.String()+req.FileId.String()+*k))
	}
	res, err := h.svc.Restore(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, scopeOf(req.Params.Scope), req.FileId, clampInt32(req.Rev), opID)
	if err != nil {
		return nil, err
	}
	return api.RestoreRevision200JSONResponse(syncmod.ToAPIResult(res)), nil
}

// clampInt32 narrows a path parameter; values beyond int32 cannot be real
// revision numbers and simply will not be found.
func clampInt32(n int) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	if n < 0 {
		return 0
	}
	return int32(n)
}

func scopeOf(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
