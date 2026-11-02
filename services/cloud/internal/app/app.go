// Package app composes the cloud modules: it creates every service once,
// wires their interfaces together and exposes the pieces main (and the
// integration tests) need. There is no DI framework: construction is explicit.
package app

import (
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/admin"
	"memobrain/services/cloud/internal/blobs"
	"memobrain/services/cloud/internal/configprofiles"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/export"
	"memobrain/services/cloud/internal/groups"
	"memobrain/services/cloud/internal/httpserver"
	"memobrain/services/cloud/internal/jobs"
	"memobrain/services/cloud/internal/keycloak"
	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/privacy"
	"memobrain/services/cloud/internal/quota"
	"memobrain/services/cloud/internal/revisions"
	"memobrain/services/cloud/internal/sharing"
	"memobrain/services/cloud/internal/storage"
	syncmod "memobrain/services/cloud/internal/sync"
	"memobrain/services/cloud/internal/users"
	"memobrain/services/cloud/internal/vaults"
)

// App holds the composed services.
type App struct {
	DB        *db.DB
	Store     storage.BlobStore
	Log       zerolog.Logger
	Users     *users.Service
	Vaults    *vaults.Service
	Quota     *quota.Service
	Blobs     *blobs.Service
	Sync      *syncmod.Service
	Revisions *revisions.Service
	Sharing   *sharing.Service
	Groups    *groups.Service
	Config    *configprofiles.Service
	Hub       *notify.Hub
	// Keycloak is the identity provider admin client; main replaces the Disabled default
	// before FillDeps, tests substitute a fake.
	Keycloak keycloak.Admin
	Admin    *admin.Service
	Privacy  *privacy.Service
	// ExportStore holds finished export archives; New defaults it to the blob store
	// (keys are prefixed, so they never collide), main points it at the exports bucket.
	ExportStore storage.BlobStore
	Exports     *export.Service
}

// New wires the modules.
func New(d *db.DB, store storage.BlobStore, log zerolog.Logger) *App {
	a := &App{DB: d, Store: store, Log: log, Keycloak: keycloak.Disabled{}, ExportStore: store}
	a.Users = users.NewService(d)
	// Every module that serves vault content asks the sharing module whether the caller may.
	a.Sharing = sharing.NewService(d)
	a.Config = configprofiles.NewService(d)
	a.Groups = groups.NewService(d, a.Config)
	a.Groups.Grants = a.Sharing // grants belong to sharing, which depends on groups (ADR-0033)
	a.Vaults = vaults.NewService(d).WithAuthorizer(a.Sharing).WithChangeIDs(syncmod.ChangeIDAt)
	a.Quota = quota.NewService(d, a.Users)
	a.Blobs = blobs.NewService(d, store, a.Sharing).WithQuota(a.Quota)
	a.Sync = syncmod.NewService(d, a.Sharing, a.Quota)
	a.Revisions = revisions.NewService(d, a.Sharing, a.Sync, a.Blobs)
	a.Hub = notify.NewHub(d, log)
	return a
}

// Jobs returns the background job runner.
func (a *App) Jobs() *jobs.Runner {
	return jobs.New(a.DB, a.Store, a.Blobs, a.Revisions, a.Log).WithExports(export.NewService(a.DB, a.Store, a.ExportStore, a.Sharing, a.Log)).
		WithIdentityProvider(a.Keycloak)
}

// FillDeps adds the module handlers to router dependencies.
func (a *App) FillDeps(d httpserver.Deps) httpserver.Deps {
	// The authentication middleware lets a suspension take effect at once on this replica.
	var inv admin.SessionInvalidator
	if d.Auth != nil {
		inv = d.Auth
	}
	a.Admin = admin.NewService(a.DB, a.Keycloak, inv, a.Users, a.Log)
	d.Admin = admin.NewHTTP(a.Admin, a.Groups, a.Config)
	a.Privacy = privacy.NewService(a.DB, a.Keycloak, inv)
	d.Privacy = privacy.NewHTTP(a.Privacy)
	a.Exports = export.NewService(a.DB, a.Store, a.ExportStore, a.Sharing, a.Log)
	d.Export = export.NewHTTP(a.Exports)
	d.Users = users.NewHTTP(a.Users)
	d.Config = configprofiles.NewHTTP(a.Config)
	d.Groups = groups.NewHTTP(a.Groups)
	d.Sharing = sharing.NewHTTP(a.Sharing)
	d.Vaults = vaults.NewHTTP(a.Vaults)
	d.Blobs = blobs.NewHTTP(a.Blobs)
	d.Sync = syncmod.NewHTTP(a.Sync)
	d.Revisions = revisions.NewHTTP(a.Revisions)
	d.Quota = quota.NewHTTP(a.Quota)
	d.Tus = blobs.NewTusHandler(a.Blobs, a.Sync.MaxFileBytes, nil)
	d.Events = a.Hub.SSEHandler()
	return d
}
