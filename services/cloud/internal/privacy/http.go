package privacy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

// HTTP implements the GDPR endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers to the service.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// exportResponse streams the export as a downloadable JSON file.
type exportResponse struct {
	data Export
}

func (r exportResponse) VisitExportMyDataResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="memobrain-account-%s.json"`, r.data.GeneratedAt.Format("20060102")))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(r.data)
}

// ExportMyData implements GET /me/export.
func (h *HTTP) ExportMyData(ctx context.Context, _ api.ExportMyDataRequestObject) (api.ExportMyDataResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	data, err := h.svc.Export(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	return exportResponse{data: data}, nil
}

// DeleteMyAccount implements DELETE /me.
func (h *HTTP) DeleteMyAccount(ctx context.Context, req api.DeleteMyAccountRequestObject) (api.DeleteMyAccountResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	if req.Body == nil || req.Body.Confirm == "" {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "confirm is required")
	}
	ack := req.Body.AcknowledgeDataLoss != nil && *req.Body.AcknowledgeDataLoss
	if err := h.svc.Delete(ctx, p.UserID, DeleteRequest{Confirm: req.Body.Confirm, AcknowledgeDataLoss: ack}); err != nil {
		return nil, err
	}
	return api.DeleteMyAccount204Response{}, nil
}
