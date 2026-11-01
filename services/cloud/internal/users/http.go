package users

import (
	"context"
	"errors"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/users/usersdb"
	"memobrain/shared/syncproto"
)

// HTTP implements the /me endpoints of the generated strict server.
type HTTP struct {
	svc *Service
}

// NewHTTP binds the handlers to the service.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// GetMe implements GET /me.
func (h *HTTP) GetMe(ctx context.Context, _ api.GetMeRequestObject) (api.GetMeResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	me, err := h.svc.GetMe(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	return api.GetMe200JSONResponse(toMe(me)), nil
}

// ListMyDevices implements GET /me/devices.
func (h *HTTP) ListMyDevices(ctx context.Context, _ api.ListMyDevicesRequestObject) (api.ListMyDevicesResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	devices, err := h.svc.ListDevices(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	items := make([]api.Device, 0, len(devices))
	for _, d := range devices {
		items = append(items, toDevice(d))
	}
	return api.ListMyDevices200JSONResponse{Items: items}, nil
}

// RegisterDevice implements POST /me/devices.
func (h *HTTP) RegisterDevice(ctx context.Context, req api.RegisterDeviceRequestObject) (api.RegisterDeviceResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	if req.Body == nil || req.Body.Name == "" {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "name is required")
	}
	d, err := h.svc.RegisterDevice(ctx, p.UserID, req.Body.Name, string(req.Body.Platform), req.Body.AppVersion)
	if err != nil {
		return nil, err
	}
	return api.RegisterDevice201JSONResponse(toDevice(d)), nil
}

// RevokeDevice implements DELETE /me/devices/{deviceId}.
func (h *HTTP) RevokeDevice(ctx context.Context, req api.RevokeDeviceRequestObject) (api.RevokeDeviceResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	err := h.svc.RevokeDevice(ctx, p.UserID, req.DeviceId)
	if errors.Is(err, ErrDeviceNotFound) {
		return nil, httpproblem.NotFound("device")
	}
	if err != nil {
		return nil, err
	}
	return api.RevokeDevice204Response{}, nil
}

func toMe(m Me) api.Me {
	u := m.User
	out := api.Me{
		Id:            u.ID,
		Username:      u.Username,
		Email:         openapi_types.Email(u.Email),
		DisplayName:   u.DisplayName,
		Role:          api.Role(u.Role),
		Status:        api.UserStatus(u.Status),
		QuotaBytes:    m.QuotaBytes,
		UsedBytes:     u.UsedBytes,
		ConfigVersion: int(m.ConfigVersion),
		CreatedAt:     u.CreatedAt,
		LastLoginAt:   u.LastLoginAt,
	}
	return out
}

func toDevice(d usersdb.Device) api.Device {
	return api.Device{
		Id:         d.ID,
		Name:       d.Name,
		Platform:   d.Platform,
		AppVersion: d.AppVersion,
		CreatedAt:  d.CreatedAt,
		LastSeenAt: d.LastSeenAt,
		RevokedAt:  d.RevokedAt,
	}
}
