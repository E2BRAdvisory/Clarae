package export

import (
	"context"
	"fmt"

	"nodus/services/cloud/internal/api"
	"nodus/services/cloud/internal/auth"
	"nodus/services/cloud/internal/db/dbgen"
)

// HTTP implements the export endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

func disposition(name string) *string {
	v := fmt.Sprintf(`attachment; filename="%s"`, name)
	return &v
}

// ExportVaultZip implements GET /vaults/{vaultId}/export.zip.
func (h *HTTP) ExportVaultZip(ctx context.Context, req api.ExportVaultZipRequestObject) (api.ExportVaultZipResponseObject, error) {
	body, name, err := h.svc.Stream(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId)
	if err != nil {
		return nil, err
	}
	return api.ExportVaultZip200ApplicationzipResponse{Body: body, Headers: api.ExportVaultZip200ResponseHeaders{ContentDisposition: disposition(name)}}, nil
}

func (h *HTTP) toJob(ctx context.Context, j dbgen.ExportJob) api.ExportJob {
	out := api.ExportJob{Id: j.ID, VaultId: j.VaultID, Status: api.ExportJobStatus(j.Status), Size: j.Size, Error: j.Error, CreatedAt: j.CreatedAt, ExpiresAt: j.ExpiresAt}
	if u := h.svc.DownloadURL(ctx, j, h.svc.Name(ctx, j)); u != "" {
		out.DownloadUrl = &u
	}
	return out
}

// CreateExport implements POST /vaults/{vaultId}/exports.
func (h *HTTP) CreateExport(ctx context.Context, req api.CreateExportRequestObject) (api.CreateExportResponseObject, error) {
	j, err := h.svc.Create(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId)
	if err != nil {
		return nil, err
	}
	return api.CreateExport202JSONResponse(h.toJob(ctx, j)), nil
}

// GetExport implements GET /vaults/{vaultId}/exports/{exportId}.
func (h *HTTP) GetExport(ctx context.Context, req api.GetExportRequestObject) (api.GetExportResponseObject, error) {
	j, err := h.svc.Job(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, req.ExportId)
	if err != nil {
		return nil, err
	}
	return api.GetExport200JSONResponse(h.toJob(ctx, j)), nil
}

// DownloadExport implements GET /vaults/{vaultId}/exports/{exportId}/download.
func (h *HTTP) DownloadExport(ctx context.Context, req api.DownloadExportRequestObject) (api.DownloadExportResponseObject, error) {
	rc, size, name, err := h.svc.Open(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, req.ExportId)
	if err != nil {
		return nil, err
	}
	return api.DownloadExport200ApplicationzipResponse{Body: rc, ContentLength: size, Headers: api.DownloadExport200ResponseHeaders{ContentDisposition: disposition(name)}}, nil
}
