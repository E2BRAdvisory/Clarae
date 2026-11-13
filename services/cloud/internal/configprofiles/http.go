// Package configprofiles distributes configuration to clients (§2.6.6).
// The effective configuration is the product defaults overlaid with the global profile and
// the profiles of the user's groups (service.go); the version is a revision that grows with
// every change, and clients refetch with If-None-Match.
package configprofiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"clarae/services/cloud/internal/api"
	"clarae/services/cloud/internal/auth"
	"clarae/shared/features"
)

// HTTP implements GET /config/effective.
type HTTP struct{ svc *Service }

// NewHTTP returns the handler.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// ProductDefaults are the built-in defaults every client starts from: the "default" keywords of
// api/config-profile.schema.json (every feature flag, the sync interval and file limit, the
// redirect mode), generated into package clarae/shared/features by `task gen`.
func ProductDefaults() map[string]any { return features.ProductDefaults() }

// GetEffectiveConfig implements GET /config/effective with ETag support.
func (h *HTTP) GetEffectiveConfig(ctx context.Context, req api.GetEffectiveConfigRequestObject) (api.GetEffectiveConfigResponseObject, error) {
	eff, err := h.svc.EffectiveFor(ctx, auth.MustPrincipal(ctx).UserID)
	if err != nil {
		return nil, err
	}
	cfg := api.EffectiveConfig{Version: int(eff.Version), Config: eff.Config, LockedKeys: eff.LockedKeys}
	etag := etagOf(cfg)
	if req.Params.IfNoneMatch != nil && *req.Params.IfNoneMatch == etag {
		return api.GetEffectiveConfig304Response{}, nil
	}
	return api.GetEffectiveConfig200JSONResponse{
		Body:    cfg,
		Headers: api.GetEffectiveConfig200ResponseHeaders{ETag: &etag},
	}, nil
}

func etagOf(cfg api.EffectiveConfig) string {
	b, _ := json.Marshal(cfg) // map keys are sorted: the encoding is canonical
	sum := sha256.Sum256(b)
	return strconv.Quote("v" + strconv.Itoa(cfg.Version) + "-" + hex.EncodeToString(sum[:8]))
}
