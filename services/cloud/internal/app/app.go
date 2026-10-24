// Package app composes the cloud modules: it creates every service once,
// wires their interfaces together and exposes the pieces main (and the
// integration tests) need. There is no DI framework: construction is explicit.
package app

import (
	"github.com/rs/zerolog"

	"nodus/services/cloud/internal/blobs"
	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/httpserver"
	"nodus/services/cloud/internal/jobs"
	"nodus/services/cloud/internal/notify"
	"nodus/services/cloud/internal/quota"
	"nodus/services/cloud/internal/revisions"
	"nodus/services/cloud/internal/storage"
	syncmod "nodus/services/cloud/internal/sync"
	"nodus/services/cloud/internal/users"
	"nodus/services/cloud/internal/vaults"
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
	Hub       *notify.Hub
}

// New wires the modules.
func New(d *db.DB, store storage.BlobStore, log zerolog.Logger) *App {
	a := &App{DB: d, Store: store, Log: log}
	a.Users = users.NewService(d)
	a.Vaults = vaults.NewService(d)
	a.Quota = quota.NewService(d, a.Users)
	a.Blobs = blobs.NewService(d, store, a.Vaults)
	a.Sync = syncmod.NewService(d, a.Vaults, a.Quota)
	a.Revisions = revisions.NewService(d, a.Vaults, a.Sync, a.Blobs)
	a.Hub = notify.NewHub(d, log)
	return a
}

// Jobs returns the background job runner.
func (a *App) Jobs() *jobs.Runner { return jobs.New(a.DB, a.Store, a.Blobs, a.Revisions, a.Log) }

// FillDeps adds the module handlers to router dependencies.
func (a *App) FillDeps(d httpserver.Deps) httpserver.Deps {
	d.Users = users.NewHTTP(a.Users)
	d.Vaults = vaults.NewHTTP(a.Vaults)
	d.Blobs = blobs.NewHTTP(a.Blobs)
	d.Sync = syncmod.NewHTTP(a.Sync)
	d.Revisions = revisions.NewHTTP(a.Revisions)
	d.Quota = quota.NewHTTP(a.Quota)
	d.Tus = blobs.NewTusHandler(a.Blobs, a.Sync.MaxFileBytes, nil)
	d.Events = a.Hub.SSEHandler()
	return d
}
