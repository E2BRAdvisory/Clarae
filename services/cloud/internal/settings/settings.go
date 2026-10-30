// Package settings owns the system settings table: the values administrators
// change at runtime (quota defaults, retention, file size limit) and the
// revision counter of the distributed configuration. Every module reads them
// through this package (ADR-0033).
package settings

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/settings/settingsdb"
)

// Get returns the raw JSON value of key; ok is false when it is not set.
func Get(ctx context.Context, tx db.DBTX, key string) (raw []byte, ok bool, err error) {
	raw, err = settingsdb.New(tx).GetSetting(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return raw, err == nil, err
}

// Int returns a positive integer setting, or def when it is missing, invalid
// or not positive.
func Int(ctx context.Context, tx db.DBTX, key string, def int64) int64 {
	raw, ok, err := Get(ctx, tx, key)
	if err != nil || !ok {
		return def
	}
	var n int64
	if json.Unmarshal(raw, &n) != nil || n <= 0 {
		return def
	}
	return n
}

// Set stores the raw JSON value of key, recording who changed it.
func Set(ctx context.Context, tx db.DBTX, key string, value []byte, by *uuid.UUID) error {
	return settingsdb.New(tx).UpsertSetting(ctx, settingsdb.UpsertSettingParams{Key: key, Value: value, UpdatedBy: by})
}

// ConfigRevision is the global revision of the distributed configuration.
func ConfigRevision(ctx context.Context, tx db.DBTX) (int64, error) {
	return settingsdb.New(tx).GetConfigRevision(ctx)
}

// BumpConfigRevision increments the revision and returns the new value; call
// it in the transaction that changes a profile, an assignment or a membership.
func BumpConfigRevision(ctx context.Context, tx db.DBTX) (int64, error) {
	return settingsdb.New(tx).BumpConfigRevision(ctx)
}
