// Package configprofiles distributes configuration to clients (§2.6.6).
// M0 serves only the product defaults with version 0; profiles, group
// assignments and locked keys arrive with M4.
package configprofiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"nodus/services/cloud/internal/api"
)

// HTTP implements GET /config/effective.
type HTTP struct{}

// NewHTTP returns the handler.
func NewHTTP() *HTTP { return &HTTP{} }

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
func (h *HTTP) GetEffectiveConfig(_ context.Context, req api.GetEffectiveConfigRequestObject) (api.GetEffectiveConfigResponseObject, error) {
	cfg := api.EffectiveConfig{Version: 0, Config: ProductDefaults(), LockedKeys: []string{}}
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
	b, _ := json.Marshal(cfg)
	sum := sha256.Sum256(b)
	return strconv.Quote("v" + strconv.Itoa(cfg.Version) + "-" + hex.EncodeToString(sum[:8]))
}
