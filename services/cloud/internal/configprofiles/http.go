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

	"nodus/services/cloud/internal/api"
	"nodus/services/cloud/internal/auth"
)

// HTTP implements GET /config/effective.
type HTTP struct{ svc *Service }

// NewHTTP returns the handler.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// ProductDefaults are the built-in defaults every client starts from. Keys
// are dotted; the schema (api/config-profile.schema.json) is defined in M4.
func ProductDefaults() map[string]any {
	return map[string]any{
		"features": map[string]any{
			"audio_recorder": false,
			"web_viewer":     false,
		},
		"sync": map[string]any{
			"interval_seconds":    30,
			"max_file_size_bytes": 104857600,
		},
		"auth": map[string]any{
			"redirect_mode": "auto",
		},
	}
}

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
