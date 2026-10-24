package blobs

import (
	"context"
	"errors"
	"fmt"

	"nodus/services/cloud/internal/api"
	"nodus/services/cloud/internal/auth"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
)

// HTTP implements the blob endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// CheckBlobs implements POST /vaults/{vaultId}/blobs:check.
func (h *HTTP) CheckBlobs(ctx context.Context, req api.CheckBlobsRequestObject) (api.CheckBlobsResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	missing, err := h.svc.Check(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, req.Body.Hashes)
	if err != nil {
		return nil, err
	}
	return api.CheckBlobs200JSONResponse{Missing: missing}, nil
}

// PutBlob implements PUT /vaults/{vaultId}/blobs/{sha256}.
func (h *HTTP) PutBlob(ctx context.Context, req api.PutBlobRequestObject) (api.PutBlobResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	if err := h.svc.Put(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, req.Sha256, req.Body); err != nil {
		return nil, err
	}
	return api.PutBlob204Response{}, nil
}

// GetBlob implements GET /vaults/{vaultId}/blobs/{sha256}.
func (h *HTTP) GetBlob(ctx context.Context, req api.GetBlobRequestObject) (api.GetBlobResponseObject, error) {
	userID := auth.MustPrincipal(ctx).UserID
	// The size is needed to resolve the range: open the whole thing first when a range is asked.
	var rng *Range
	if hdr := req.Params.Range; hdr != nil && *hdr != "" {
		size, err := h.svc.Size(ctx, userID, req.VaultId, req.Sha256)
		if err != nil {
			return nil, err
		}
		r, ok, err := ParseRange(*hdr, size)
		if errors.Is(err, ErrRange) {
			detail := fmt.Sprintf("blob size is %d bytes", size)
			return api.GetBlob416ApplicationProblemPlusJSONResponse(api.Problem{
				Type: syncproto.ProblemTypeBase + "range-not-satisfiable", Title: "Range not satisfiable", Status: 416,
				Code: api.VALIDATIONFAILED, Detail: &detail,
			}), nil
		}
		if err != nil {
			return nil, err
		}
		if ok {
			rng = &r
		}
	}
	rc, size, err := h.svc.Open(ctx, userID, req.VaultId, req.Sha256, rng)
	if err != nil {
		return nil, err
	}
	accept := "bytes"
	if rng == nil {
		return api.GetBlob200ApplicationoctetStreamResponse{Body: rc, ContentLength: size, Headers: api.GetBlob200ResponseHeaders{AcceptRanges: &accept}}, nil
	}
	cr := fmt.Sprintf("bytes %d-%d/%d", rng.Start, rng.End, size)
	return api.GetBlob206ApplicationoctetStreamResponse{Body: rc, ContentLength: rng.End - rng.Start + 1, Headers: api.GetBlob206ResponseHeaders{ContentRange: &cr}}, nil
}
