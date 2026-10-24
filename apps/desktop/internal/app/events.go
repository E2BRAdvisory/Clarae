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

// emit sends an event to the frontend. Tests replace App.emitter because the
// Wails runtime aborts the process when given a context it did not create.
func (a *App) emit(name string, payload any) {
	a.emitterMu.RLock()
	emitter := a.emitter
	a.emitterMu.RUnlock()
	if emitter != nil {
		emitter(name, payload)
		return
	}
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, name, payload)
}

// setEmitter swaps the emitter while background goroutines (indexer, watcher) may be emitting.
func (a *App) setEmitter(f func(string, any)) {
	a.emitterMu.Lock()
	a.emitter = f
	a.emitterMu.Unlock()
}
