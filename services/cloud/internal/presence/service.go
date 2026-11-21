package presence

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"

	"clarae/services/cloud/internal/access"
	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/configprofiles"
	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/notify"
	"clarae/services/cloud/internal/sharing"
	syncmod "clarae/services/cloud/internal/sync"
	"clarae/services/cloud/internal/users"
	"clarae/services/cloud/internal/vaults"
	"clarae/shared/features"
)

// Denials of CanView.
var (
	// ErrNotFound: no such file, or the user may not know about it.
	ErrNotFound = errors.New("presence: not found")
	// ErrEncrypted: the vault is private (end-to-end encrypted): it has no presence.
	ErrEncrypted = errors.New("presence: vault is encrypted")
)

// Env is what the WebSocket handler needs from the rest of the service; the
// modules implement it in Service and tests use fakes.
type Env interface {
	// Authenticate verifies a raw access token like the HTTP middleware: the
	// same verifier, the same suspension check with its cache.
	Authenticate(ctx context.Context, raw string) (auth.Principal, time.Time, error)
	// DisplayName is the name stamped on the members the user appears as.
	DisplayName(ctx context.Context, user uuid.UUID) (string, error)
	// Enabled reports the features.presence flag of the user's Config Profile.
	Enabled(ctx context.Context, user uuid.UUID) (bool, error)
	// CanView checks that the user may read the file of the room: nil, ErrNotFound or ErrEncrypted.
	CanView(ctx context.Context, user uuid.UUID, room Room) error
	// Subscribe returns the events (share, account, configuration) of the user and the func that ends the subscription.
	Subscribe(user uuid.UUID) (*notify.Sub, func())
}

// Authenticator is the part of auth.Middleware the module uses.
type Authenticator interface {
	AuthenticateExp(ctx context.Context, raw string) (auth.Principal, time.Time, error)
}

// Service wires the presence hub to the modules it depends on.
type Service struct {
	Hub *Hub

	db      *db.DB
	log     zerolog.Logger
	sharing *sharing.Service
	config  *configprofiles.Service
	events  *notify.Hub
	bus     *PGBus
}

// NewService creates the module: its hub and the bus to the other replicas.
func NewService(d *db.DB, log zerolog.Logger, sh *sharing.Service, cfg *configprofiles.Service, events *notify.Hub) *Service {
	hub := NewHub(log, nil)
	s := &Service{Hub: hub, db: d, log: log, sharing: sh, config: cfg, events: events}
	s.bus = NewPGBus(d.Pool, log, hub)
	return s
}

// Run listens to the other replicas and keeps the heartbeat until ctx ends.
func (s *Service) Run(ctx context.Context) error {
	done := make(chan struct{})
	go func() { defer close(done); s.Hub.Run(ctx) }()
	err := s.bus.Run(ctx)
	<-done
	return err
}

// Handler returns the WebSocket endpoint authenticating with authn.
func (s *Service) Handler(authn Authenticator, opts Options) *Handler {
	return NewHandler(&env{Service: s, authn: authn}, s.Hub, s.log, opts)
}

type env struct {
	*Service
	authn Authenticator
}

func (e *env) Authenticate(ctx context.Context, raw string) (auth.Principal, time.Time, error) {
	return e.authn.AuthenticateExp(ctx, raw)
}

func (e *env) DisplayName(ctx context.Context, user uuid.UUID) (string, error) {
	b, err := users.GetUserBrief(ctx, e.db.Pool, user)
	if err != nil {
		return "", err
	}
	if b.DisplayName != nil && strings.TrimSpace(*b.DisplayName) != "" {
		return strings.TrimSpace(*b.DisplayName), nil
	}
	return b.Username, nil
}

func (e *env) Enabled(ctx context.Context, user uuid.UUID) (bool, error) {
	eff, err := e.config.EffectiveFor(ctx, user)
	if err != nil {
		return false, err
	}
	return features.Enabled(eff.Config, "presence"), nil
}

// CanView: the vault must be shared (a private one has no presence: path and
// content are opaque to the server and nobody else reads it), the file must
// exist and be live, and the effective permission of the user on its current
// path must be at least viewer, whether through ownership, a vault, folder or
// document share, directly or through a group.
func (e *env) CanView(ctx context.Context, user uuid.UUID, room Room) error {
	pool := e.db.Pool
	v, err := vaults.GetVault(ctx, pool, room.Vault)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if v.DeletedAt != nil {
		return ErrNotFound
	}
	if v.Kind == "private" {
		if v.OwnerID == user {
			return ErrEncrypted
		}
		return ErrNotFound
	}
	f, err := syncmod.GetFile(ctx, pool, room.Vault, room.File)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if f.IsDeleted {
		return ErrNotFound
	}
	perm, err := e.sharing.Evaluator(user).Effective(ctx, v, f.Path)
	if err != nil {
		return err
	}
	if perm < access.Viewer {
		return ErrNotFound
	}
	return nil
}

func (e *env) Subscribe(user uuid.UUID) (*notify.Sub, func()) {
	s := e.events.Subscribe(user)
	return s, func() { e.events.Unsubscribe(s) }
}
