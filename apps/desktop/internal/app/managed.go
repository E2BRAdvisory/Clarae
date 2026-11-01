package app

import (
	"errors"
	"os"
	"strings"
	"time"

	"memobrain/apps/desktop/internal/auth"
	"memobrain/apps/desktop/internal/history"
)

// Configuration keys the backend applies itself (the frontend handles the others).
const (
	cfgVaultLock = "security.vault_lock_minutes"
	// cfgEnvelopeV2 switches the writing of v2 key envelopes (ADR-0034). Off
	// unless the administrator turns it on: release N reads both formats and
	// writes v1, so devices that are not updated yet keep unlocking.
	cfgEnvelopeV2 = "features.envelope_v2"
	// maxVaultLockMinutes bounds the idle timeout of private vaults (one day).
	maxVaultLockMinutes = 1440
)

// configValue reads a dotted key ("section.key") of the effective configuration.
func configValue(cfg map[string]any, key string) (any, bool) {
	sec, name, ok := strings.Cut(key, ".")
	if !ok {
		return nil, false
	}
	m, ok := cfg[sec].(map[string]any)
	if !ok {
		return nil, false
	}
	v, ok := m[name]
	return v, ok
}

// configInt reads a numeric key (JSON numbers decode as float64).
func configInt(cfg map[string]any, key string) (int64, bool) {
	v, ok := configValue(cfg, key)
	if !ok {
		return 0, false
	}
	f, ok := v.(float64)
	return int64(f), ok
}

// keyLocked reports whether the administrator locked key, or its whole section.
func keyLocked(locked []string, key string) bool {
	for _, l := range locked {
		if l == key || strings.HasPrefix(key, l+".") {
			return true
		}
	}
	return false
}

// effectiveLockMinutes resolves the idle timeout of private vaults: a locked
// administrator value wins, then the user's own choice, then the
// administrator's default, then never (0). The VMK stays in the keychain
// after unlock by default (§3.8.2), so "never" keeps that behavior.
func effectiveLockMinutes(user *int, managed int64, hasManaged, locked bool) int {
	clamp := func(n int64) int { return int(min(max(n, 0), maxVaultLockMinutes)) }
	switch {
	case hasManaged && locked:
		return clamp(managed)
	case user != nil:
		return clamp(int64(*user))
	case hasManaged:
		return clamp(managed)
	}
	return 0
}

// applyLockTimeout hands the idle timeout to the sync manager (and so to the
// key manager). It runs at startup, on every configuration change and when
// the user changes the setting.
func (a *App) applyLockTimeout() {
	settings, _ := (&SettingsAPI{app: a}).Get()
	cur := a.config.Current()
	managed, has := configInt(cur.Config, cfgVaultLock)
	minutes := effectiveLockMinutes(settings.VaultLockMinutes, managed, has, keyLocked(cur.LockedKeys, cfgVaultLock))
	a.sync.SetLockTimeout(time.Duration(minutes) * time.Minute)
}

// envelopeV2Enabled reads features.envelope_v2 (default off).
func envelopeV2Enabled(cfg map[string]any) bool {
	v, _ := configValue(cfg, cfgEnvelopeV2)
	on, _ := v.(bool)
	return on
}

// envRedirectMode is the redirect mode forced from the environment
// (MEMOBRAIN_AUTH_REDIRECT, used by the manual checklist); "" lets the
// Config Profile decide.
func envRedirectMode() auth.RedirectMode {
	return auth.ParseRedirectMode(os.Getenv("MEMOBRAIN_AUTH_REDIRECT"))
}

// snapshotBeforeOverwrite keeps the local content a sync merge is about to
// replace in the vault's local history (reason pre-sync-overwrite, §2.9). A
// failure is logged and never stops the sync.
func (a *App) snapshotBeforeOverwrite(vaultID, path string) {
	v, err := a.vault(vaultID)
	if err != nil {
		return // not open in this window: nothing to snapshot with
	}
	_, _, err = v.History.Take(path, history.ReasonPreSyncOverride)
	if err != nil && !errors.Is(err, history.ErrSkipped) && !errors.Is(err, history.ErrReadOnly) && !os.IsNotExist(err) {
		a.logger.Warn().Err(err).Str("vault", vaultID).Str("path", path).Msg("pre-sync snapshot")
	}
}
