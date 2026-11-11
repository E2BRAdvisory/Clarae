package app

import (
	"memobrain/apps/desktop/internal/auth"
	"memobrain/apps/desktop/internal/events"
)

// Events the app itself sends to the frontend (§2.5). Each is declared with its payload type and
// sent with Send, never by name; every event of the core is listed in the registry
// (events_registry.go), from which `task gen` writes packages/workbench/src/app/events.gen.ts.
var (
	EventVaultFileChanged = events.New[FileChangedPayload]("vault:file-changed",
		"Files of an open vault changed on disk (by the app, the watcher or a sync). `changes` classifies `paths`;\n"+
			"older cores omit it: consumers must then assume anything changed.")
	EventIndexProgress = events.New[IndexProgressPayload]("index:progress",
		"Progress of the indexing of a vault.")
	EventAuthState = events.New[auth.State]("auth:state",
		"The cloud session changed (signed in or out, server unreachable, device revoked).")
	EventConfigUpdated = events.New[ConfigState]("config:updated",
		"The distributed configuration in force changed: the new configuration and its feature flags.")
	EventOpenRequest = events.New[OpenRequestPayload]("app:open-request",
		"A memobrain://open link handled by the operating system asks to open a vault (and a file).")
	EventMountsChanged = events.New[MountsChangedPayload]("mounts:changed",
		"Mount levels or availability changed on this device (after a reconcile with the server).")
	EventImportProgress = events.New[ImportProgressPayload]("importer:progress",
		"Progress of an import job.")
	EventImportDone = events.New[ImportDonePayload]("importer:done",
		"An import job ended (completed, cancelled or failed).")
	// EventBeforeClose asks the frontend to write its pending edits before the desktop app quits;
	// it answers by calling the runtime Quit again (packages/workbench/src/app/lifecycle.ts). Sent
	// by main.go, outside the App.
	EventBeforeClose = events.NewSignal("app:before-close",
		"Desktop: the window is closing; write the pending edits, then call the runtime Quit again.")
)

// FileChangedPayload accompanies EventVaultFileChanged. Paths lists every path of the batch;
// Changes says, for each, whether it was created, modified or deleted (see FileChange).
type FileChangedPayload struct {
	VaultID string       `json:"vaultId"`
	Paths   []string     `json:"paths"`
	Changes []FileChange `json:"changes,omitempty"`
}

// IndexProgressPayload accompanies EventIndexProgress.
type IndexProgressPayload struct {
	VaultID  string `json:"vaultId"`
	Done     int    `json:"done"`
	Total    int    `json:"total"`
	Path     string `json:"path"`
	Finished bool   `json:"finished"`
}

// OpenRequestPayload accompanies EventOpenRequest.
type OpenRequestPayload struct {
	Vault string `json:"vault"`
	File  string `json:"file"`
}

// MountsChangedPayload accompanies EventMountsChanged.
type MountsChangedPayload struct {
	// Changed counts the mounts that were updated.
	Changed int `json:"changed"`
}

// emit sends an event to the frontend (an events.Emitter: events are sent with Event.Send). Tests
// replace App.emitter because the desktop host sends through the Wails application, which tests do not have.
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
	a.host.Emit(a.ctx, name, payload)
}

// setEmitter swaps the emitter while background goroutines (indexer, watcher) may be emitting.
func (a *App) setEmitter(f func(string, any)) {
	a.emitterMu.Lock()
	a.emitter = f
	a.emitterMu.Unlock()
}
