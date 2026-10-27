// Package config holds the configuration the cloud distributes to this device (§2.6.6):
// it fetches the effective profile with ETag, keeps the last valid one in app.db so it
// works offline, and tells which keys the administrator locked. The frontend merges it
// with the user's own settings; this package never interprets individual keys.
package config

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"memobrain/apps/desktop/internal/sync/transport"
)

// Effective is the configuration as the application uses it.
type Effective struct {
	Version int            `json:"version"`
	Config  map[string]any `json:"config"`
	// LockedKeys are dotted keys the user cannot override.
	LockedKeys []string `json:"lockedKeys"`
	// Managed is true once a configuration from a server applies (fresh or cached).
	Managed   bool   `json:"managed"`
	FetchedAt string `json:"fetchedAt"`
}

// Fetcher asks the server for the effective configuration (transport.Client.GetEffectiveConfig).
type Fetcher func(ctx context.Context, etag string) (cfg transport.EffectiveConfig, newETag string, changed bool, err error)

type cached struct {
	ETag      string                    `json:"etag"`
	Effective transport.EffectiveConfig `json:"effective"`
	FetchedAt time.Time                 `json:"fetchedAt"`
}

// Service keeps the current configuration.
type Service struct {
	db *sql.DB

	mu  sync.Mutex
	cur Effective
	tag string
	key string
}

// New binds the service to the application database (table app_settings).
func New(db *sql.DB) *Service {
	return &Service{db: db, cur: Effective{Config: map[string]any{}, LockedKeys: []string{}}}
}

func cacheKey(serverURL string) string { return "cloud_config:" + serverURL }

// Load restores the cached configuration of a server (offline start).
func (s *Service) Load(ctx context.Context, serverURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.key = cacheKey(serverURL)
	s.cur, s.tag = Effective{Config: map[string]any{}, LockedKeys: []string{}}, ""
	if s.db == nil || serverURL == "" {
		return
	}
	var raw string
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = ?`, s.key).Scan(&raw); err != nil {
		return
	}
	var c cached
	if json.Unmarshal([]byte(raw), &c) != nil {
		return
	}
	s.cur, s.tag = fromServer(c.Effective, c.FetchedAt), c.ETag
}

func fromServer(e transport.EffectiveConfig, at time.Time) Effective {
	locked := e.LockedKeys
	if locked == nil {
		locked = []string{}
	}
	cfg := e.Config
	if cfg == nil {
		cfg = map[string]any{}
	}
	return Effective{Version: e.Version, Config: cfg, LockedKeys: locked, Managed: true, FetchedAt: at.UTC().Format(time.RFC3339)}
}

// Current returns the configuration in force.
func (s *Service) Current() Effective {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// Version is the revision this device holds (0 before any fetch).
func (s *Service) Version() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur.Version
}

// Refresh fetches the configuration and stores it when it changed. A failure keeps the
// cached one: the device keeps working offline with the last valid configuration.
func (s *Service) Refresh(ctx context.Context, serverURL string, fetch Fetcher) (changed bool, err error) {
	if fetch == nil {
		return false, errors.New("not signed in to the cloud")
	}
	s.mu.Lock()
	if s.key != cacheKey(serverURL) {
		s.mu.Unlock()
		s.Load(ctx, serverURL)
		s.mu.Lock()
	}
	tag := s.tag
	s.mu.Unlock()
	cfg, newTag, did, err := fetch(ctx, tag)
	if err != nil || !did {
		return false, err
	}
	now := time.Now()
	s.mu.Lock()
	s.cur, s.tag = fromServer(cfg, now), newTag
	key, db := s.key, s.db
	s.mu.Unlock()
	if db != nil {
		raw, merr := json.Marshal(cached{ETag: newTag, Effective: cfg, FetchedAt: now})
		if merr == nil {
			_, _ = db.ExecContext(ctx, `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, string(raw))
		}
	}
	return true, nil
}
