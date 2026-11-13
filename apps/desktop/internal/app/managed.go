package app

import (
	"errors"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/auth"
	"clarae/apps/desktop/internal/history"
	flags "clarae/shared/features"
)

// Configuration keys the backend applies itself (the frontend handles the others).
const (
	cfgVaultLock = "security.vault_lock_minutes"
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

// envelopeV2Enabled reads features.envelope_v2, which switches the writing of
// v2 key envelopes (ADR-0034). On unless the administrator turns it off (the
// schema's default since release N+1): desktop 1.2.4 and earlier cannot open a
// v2 envelope, so an instance with such devices can postpone it. Off, a kind
// already seen in v2 still stays v2 (crypto.Manager.writeV2).
func envelopeV2Enabled(cfg map[string]any) bool {
	return flags.Enabled(cfg, flags.EnvelopeV2)
}

// pathV2Enabled reads features.path_v2, which switches the writing of enc2
// path tokens of private vaults and the background migration of the enc1 ones
// (ADR-0042). On by default like envelope_v2; off, a vault pinned to enc2 still
// writes enc2 (sync.Engine.writePathV2).
func pathV2Enabled(cfg map[string]any) bool {
	return flags.Enabled(cfg, flags.PathV2)
}

// configDirV2Enabled reads features.config_dir_v2, which lets the sync engine move the synchronized
// settings of a linked vault from the former configuration folder to the current one (ADR-0052).
// Off by default in 1.5.0: clients of 1.x sharing the vault still use the former folder.
func configDirV2Enabled(cfg map[string]any) bool {
	return flags.Enabled(cfg, flags.ConfigDirV2)
}

// envRedirectMode is the redirect mode forced from the environment
// (CLARAE_AUTH_REDIRECT, used by the manual checklist); "" lets the
// Config Profile decide.
func envRedirectMode(logger zerolog.Logger) auth.RedirectMode {
	return auth.ParseRedirectMode(envValue(logger, "AUTH_REDIRECT"))
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
	switch {
	case err == nil, errors.Is(err, history.ErrReadOnly), os.IsNotExist(err):
	case errors.Is(err, history.ErrSkipped):
		// Too large (or not a vault file): the merge goes on without a
		// local copy, which must at least be on record.
		a.logger.Warn().Str("vault", vaultID).Str("path", path).Int64("maxBytes", history.PreSyncMaxBytes).
			Msg("pre-sync snapshot skipped: the local version is not kept in the history")
	default:
		a.logger.Warn().Err(err).Str("vault", vaultID).Str("path", path).Msg("pre-sync snapshot")
	}
}
