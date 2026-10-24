package app

import "github.com/wailsapp/wails/v2/pkg/runtime"

// Event names emitted from Go to the frontend (§2.5). The TypeScript side
// mirrors them in frontend/src/app/events.ts.
const (
	EventVaultFileChanged = "vault:file-changed"
	EventIndexProgress    = "index:progress"
	EventSyncStatus       = "sync:status"
	EventSyncConflict     = "sync:conflict"
	EventVaultLocked      = "vault:locked"
	EventAuthState        = "auth:state"
	EventConfigUpdated    = "config:updated"
	EventOpenRequest      = "app:open-request" // nodus://open handled by the OS
)

// FileChangedPayload accompanies EventVaultFileChanged.
type FileChangedPayload struct {
	VaultID string   `json:"vaultId"`
	Paths   []string `json:"paths"`
}

// OpenRequestPayload accompanies EventOpenRequest.
type OpenRequestPayload struct {
	Vault string `json:"vault"`
	File  string `json:"file"`
}

func (a *App) emit(name string, payload any) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, name, payload)
}
