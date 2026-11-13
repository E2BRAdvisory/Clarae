package quota

import (
	"context"

	"clarae/services/cloud/internal/api"
	"clarae/services/cloud/internal/auth"
)

// HTTP implements GET /me/usage.
type HTTP struct{ svc *Service }

// NewHTTP binds the handler.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// GetMyUsage implements GET /me/usage.
func (h *HTTP) GetMyUsage(ctx context.Context, _ api.GetMyUsageRequestObject) (api.GetMyUsageResponseObject, error) {
	u, err := h.svc.Usage(ctx, auth.MustPrincipal(ctx).UserID)
	if err != nil {
		return nil, err
	}
	return api.GetMyUsage200JSONResponse(api.Usage{UsedBytes: u.UsedBytes, QuotaBytes: u.QuotaBytes, Level: api.UsageLevel(u.Level)}), nil
}
