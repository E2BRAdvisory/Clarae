// Package quota computes the effective storage quota, the usage level and
// charges owners when files change (§2.6.3, D-03: only current files count).
package quota

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/db/dbgen"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
)

// Unlimited is the quota value for accounts without a limit.
const Unlimited int64 = -1

// Level is how close an account is to its quota.
type Level string

// Levels (thresholds are settings: storage.warn_percent, storage.critical_percent).
const (
	LevelOK       Level = "ok"
	LevelWarning  Level = "warning"
	LevelCritical Level = "critical"
	LevelFull     Level = "full"
)

// QuotaSource resolves the effective quota of a user (users module).
type QuotaSource interface {
	EffectiveQuota(ctx context.Context, u dbgen.User) (int64, error)
}

// Service implements the quota module.
type Service struct {
	db    *db.DB
	quota QuotaSource
}

// NewService wires the module.
func NewService(d *db.DB, q QuotaSource) *Service { return &Service{db: d, quota: q} }

// Usage is the storage state of one user.
type Usage struct {
	UsedBytes  int64
	QuotaBytes int64
	Level      Level
}

func (s *Service) percent(ctx context.Context, key string, def int) int {
	raw, err := s.db.Queries().GetSetting(ctx, key)
	if err != nil {
		return def
	}
	var n int
	if json.Unmarshal(raw, &n) != nil || n <= 0 || n > 100 {
		return def
	}
	return n
}

// LevelFor classifies used against quota with the configured thresholds.
func LevelFor(used, quota int64, warnPct, critPct int) Level {
	if quota < 0 {
		return LevelOK
	}
	switch {
	case used >= quota:
		return LevelFull
	case quota > 0 && used*100 >= quota*int64(critPct):
		return LevelCritical
	case quota > 0 && used*100 >= quota*int64(warnPct):
		return LevelWarning
	default:
		return LevelOK
	}
}

// Usage returns the current usage of a user.
func (s *Service) Usage(ctx context.Context, userID uuid.UUID) (Usage, error) {
	u, err := s.db.Queries().GetUserByID(ctx, userID)
	if err != nil {
		return Usage{}, err
	}
	quota, err := s.quota.EffectiveQuota(ctx, u)
	if err != nil {
		return Usage{}, err
	}
	return Usage{
		UsedBytes:  u.UsedBytes,
		QuotaBytes: quota,
		Level:      LevelFor(u.UsedBytes, quota, s.percent(ctx, "storage.warn_percent", 80), s.percent(ctx, "storage.critical_percent", 95)),
	}, nil
}

// QuotaOf returns the effective quota of a user (before opening transactions).
func (s *Service) QuotaOf(ctx context.Context, userID uuid.UUID) (int64, error) {
	u, err := s.db.Queries().GetUserByID(ctx, userID)
	if err != nil {
		return 0, err
	}
	return s.quota.EffectiveQuota(ctx, u)
}

// Charge adds delta bytes to the owner's usage inside a transaction and fails
// with QUOTA_EXCEEDED when that would exceed quota. Releasing space (delta
// <= 0) always succeeds.
func Charge(ctx context.Context, q *dbgen.Queries, ownerID uuid.UUID, delta, quota int64) error {
	n, err := q.ChargeUser(ctx, dbgen.ChargeUserParams{ID: ownerID, Delta: delta, Quota: quota})
	if err != nil {
		return err
	}
	if n == 1 {
		return nil
	}
	used, err := q.UserUsedBytes(ctx, ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpproblem.NotFound("user")
	}
	if err != nil {
		return err
	}
	return &httpproblem.Error{
		Code:   syncproto.CodeQuotaExceeded,
		Detail: "storage quota exceeded",
		Extra:  map[string]any{"used_bytes": used, "quota_bytes": quota},
	}
}
