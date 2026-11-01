package sync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"time"

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/vaultcrypto"
)

// LinkResult is returned when a vault is connected to the cloud.
type LinkResult struct {
	CloudVaultID string `json:"cloudVaultId"`
	// RecoveryKey is set for private vaults and shown to the user exactly once.
	RecoveryKey string `json:"recoveryKey"`
}

// Info returns the cloud connection of a vault.
func (m *Manager) Info(ctx context.Context, localID string) (LinkInfo, error) {
	mv, err := m.get(localID)
	if err != nil {
		return LinkInfo{}, err
	}
	cloud, _ := mv.db.Meta(ctx, MetaCloudVault)
	if cloud == "" {
		return LinkInfo{}, nil
	}
	kind, _ := mv.db.Meta(ctx, MetaKind)
	name, _ := mv.db.Meta(ctx, MetaVaultName)
	server, _ := mv.db.Meta(ctx, MetaServerURL)
	paused, _ := mv.db.Meta(ctx, MetaPaused)
	poll, _ := mv.db.MetaInt(ctx, MetaPollSeconds)
	info := LinkInfo{PollSeconds: poll, Linked: true, CloudVaultID: cloud, Kind: kind, Name: name, ServerURL: server, Paused: paused == "1", Locked: kind == "private" && m.crypto.IsLocked(cloud), Permission: PermOwner}
	if mm, ok, _ := readMountMeta(ctx, mv.db); ok {
		info.Mount, info.Permission, info.Revoked = true, mm.Permission, mm.Revoked
		info.ReadOnly = mm.Revoked || mm.Permission == PermViewer
		info.OwnerName, info.ShareID, info.Name = mm.OwnerName, mm.ShareID, mm.Name
	}
	return info, nil
}

// Status returns the latest status of a vault.
func (m *Manager) Status(ctx context.Context, localID string) (Status, error) {
	mv, err := m.get(localID)
	if err != nil {
		return Status{}, err
	}
	eng := m.engineOf(mv)
	if eng == nil {
		return Status{VaultID: localID, Phase: PhaseIdle}, nil
	}
	st := eng.Status()
	if _, ok := m.session.Info(); !ok && st.Phase == PhaseIdle {
		st.Phase, st.Error = PhaseOffline, "signed out of the cloud"
	}
	return st, nil
}

func (m *Manager) client() (*transport.Client, SessionInfo, error) {
	info, ok := m.session.Info()
	c := m.session.Client()
	if !ok || c == nil {
		return nil, info, errSignedOut
	}
	return c, info, nil
}

func (m *Manager) saveLink(ctx context.Context, mv *managed, v transport.Vault, info SessionInfo) error {
	for k, val := range map[string]string{
		MetaCloudVault: v.Id.String(), MetaKind: string(v.Kind), MetaServerURL: info.ServerURL, MetaDeviceID: info.DeviceID,
		MetaUserID: info.UserID, MetaVaultName: v.Name, MetaLinkedAt: time.Now().UTC().Format(time.RFC3339),
	} {
		if err := mv.db.SetMeta(ctx, k, val); err != nil {
			return err
		}
	}
	_ = mv.db.DeleteMeta(ctx, MetaBootstrapped)
	_ = mv.db.DeleteMeta(ctx, MetaPaused)
	return nil
}

// Link creates a cloud vault for the local one and starts the first upload.
// kind is "shared" or "private"; private vaults need a passphrase and return
// the recovery key. The kind cannot be changed afterwards (D-02).
func (m *Manager) Link(ctx context.Context, localID, name, kind, passphrase string) (LinkResult, error) {
	mv, err := m.get(localID)
	if err != nil {
		return LinkResult{}, err
	}
	if cloud, _ := mv.db.Meta(ctx, MetaCloudVault); cloud != "" {
		return LinkResult{}, errors.New("this vault is already connected to the cloud")
	}
	c, info, err := m.client()
	if err != nil {
		return LinkResult{}, err
	}
	var res LinkResult
	var v transport.Vault
	var mat crypto.Material
	switch kind {
	case "shared":
		v, err = c.CreateVault(ctx, name, "shared", nil)
	case "private":
		if mat, err = m.crypto.NewMaterial(passphrase); err != nil {
			return LinkResult{}, err
		}
		if v, err = c.CreateVault(ctx, name, "private", mat.Envelopes); err != nil {
			return LinkResult{}, err
		}
		if err = m.crypto.Adopt(v.Id.String(), mat); err != nil {
			return LinkResult{}, err
		}
		res.RecoveryKey = mat.RecoveryKey
	default:
		return LinkResult{}, fmt.Errorf("unknown vault kind %q", kind)
	}
	if err != nil {
		return LinkResult{}, err
	}
	res.CloudVaultID = v.Id.String()
	if err := m.saveLink(ctx, mv, v, info); err != nil {
		return res, err
	}
	if kind == "private" && m.crypto.EnvelopeV2() {
		m.upgradeNewVaultEnvelopes(ctx, mv, c, v.Id.String(), mat)
	}
	if err := m.activate(ctx, mv); err != nil {
		return res, err
	}
	m.kickNow(mv)
	return res, nil
}

// CloudVaults lists the account's cloud vaults (to connect a folder on a new device).
func (m *Manager) CloudVaults(ctx context.Context) ([]transport.Vault, error) {
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	return c.ListVaults(ctx)
}

// LinkExisting connects the local folder to a cloud vault that already exists
// (a new device): the first synchronization downloads it (§3.8.4 flow 2).
// A private vault stays locked until Unlock succeeds.
func (m *Manager) LinkExisting(ctx context.Context, localID, cloudVaultID string) error {
	mv, err := m.get(localID)
	if err != nil {
		return err
	}
	if cloud, _ := mv.db.Meta(ctx, MetaCloudVault); cloud != "" {
		return errors.New("this vault is already connected to the cloud")
	}
	c, info, err := m.client()
	if err != nil {
		return err
	}
	v, err := c.GetVault(ctx, cloudVaultID)
	if err != nil {
		return err
	}
	if err := m.saveLink(ctx, mv, v, info); err != nil {
		return err
	}
	if err := m.activate(ctx, mv); err != nil {
		return err
	}
	m.kickNow(mv)
	return nil
}

// Unlink disconnects the vault: local files stay, the server copy is untouched,
// the encryption key is removed from this device.
func (m *Manager) Unlink(ctx context.Context, localID string) error {
	mv, err := m.get(localID)
	if err != nil {
		return err
	}
	m.mu.Lock()
	done := m.stopLocked(mv)
	cloud, kind := mv.cloudID, mv.kind
	mv.engine, mv.cloudID, mv.kind, mv.scope = nil, "", "", ""
	m.mu.Unlock()
	waitLoop(done) // no cycle may write the state erased below
	if cloud != "" && kind == "private" {
		_ = m.crypto.Forget(cloud)
	}
	for _, k := range []string{MetaCloudVault, MetaKind, MetaServerURL, MetaDeviceID, MetaUserID, MetaVaultName, MetaBootstrapped, MetaPaused, MetaLinkedAt, MetaLastScan, MetaScope, MetaPermission, MetaShareID, MetaMountName, MetaOwnerName, MetaResourceType, MetaRevoked} {
		_ = mv.db.DeleteMeta(ctx, k)
	}
	if _, err := mv.sdb.ExecContext(ctx, resetSQL); err != nil {
		return err
	}
	m.publish(mv)
	return nil
}

// SetPaused pauses or resumes synchronization of a vault.
func (m *Manager) SetPaused(ctx context.Context, localID string, paused bool) error {
	mv, err := m.linked(localID)
	if err != nil {
		return err
	}
	v := ""
	if paused {
		v = "1"
	}
	if err := mv.db.SetMeta(ctx, MetaPaused, v); err != nil {
		return err
	}
	if paused {
		mv.engine.setStatus(func(s *Status) { s.Phase = PhasePaused })
	} else {
		m.kickNow(mv.managed)
	}
	return nil
}

// SetPollInterval sets how often the server is polled when no notification
// arrives; 0 restores the automatic interval (30 s growing to 5 min).
func (m *Manager) SetPollInterval(ctx context.Context, localID string, seconds int) error {
	mv, err := m.linked(localID)
	if err != nil {
		return err
	}
	if seconds < 0 || (seconds > 0 && seconds < 15) {
		return errors.New("the interval must be 0 (automatic) or at least 15 seconds")
	}
	if err := mv.db.SetMeta(ctx, MetaPollSeconds, strconv.Itoa(seconds)); err != nil {
		return err
	}
	m.kickNow(mv.managed)
	return nil
}

// SyncNow requests an immediate synchronization.
func (m *Manager) SyncNow(localID string) error {
	mv, err := m.linked(localID)
	if err != nil {
		return err
	}
	m.startLoop(mv.managed)
	m.kickNow(mv.managed)
	return nil
}

// --- encryption --------------------------------------------------------------

func (m *Manager) privateVault(localID string) (linkView, *transport.Client, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return linkView{}, nil, err
	}
	if mv.kind != "private" {
		return linkView{}, nil, errors.New("only private vaults are encrypted")
	}
	c, _, err := m.client()
	return mv, c, err
}

// Unlock opens a private vault with the passphrase or the recovery key. When
// the recovery key was used requiresNewPassphrase is true and the caller must
// invoke SetPassphrase (§3.8.4 flow 4).
func (m *Manager) Unlock(ctx context.Context, localID, secret string, recovery bool) (requiresNewPassphrase bool, err error) {
	mv, c, err := m.privateVault(localID)
	if err != nil {
		return false, err
	}
	envs, err := c.GetKeyEnvelopes(ctx, mv.cloudID)
	if err != nil {
		return false, err
	}
	res, err := m.crypto.UnlockWith(mv.cloudID, envs, secret, recovery, crypto.UnlockOptions{PinnedV2: m.envelopePins(ctx, mv.managed, mv.cloudID)})
	if err != nil {
		return false, err
	}
	if res.Version == 2 {
		m.pinEnvelopeV2(ctx, mv.managed, mv.cloudID, res.Kind)
	}
	if res.Upgrade != nil {
		m.uploadUpgradedEnvelope(ctx, mv.managed, c, mv.cloudID, envs, *res.Upgrade)
	}
	m.kickNow(mv.managed)
	return res.RequiresNewPassphrase, nil
}

// --- key envelope formats (ADR-0034) ----------------------------------------

// metaEnvelopeV2 is the sync.db key that pins an envelope kind of a cloud
// vault to format v2. The cloud id is part of the key, so a folder linked
// again to another vault never inherits the pin.
func metaEnvelopeV2(cloudID, kind string) string { return "envelope_v2:" + cloudID + ":" + kind }

// envelopePins returns the envelope kinds pinned to v2 for the vault and hands
// them to the key manager, so a re-wrap of those kinds stays v2.
func (m *Manager) envelopePins(ctx context.Context, mv *managed, cloudID string) map[string]bool {
	pins := map[string]bool{}
	for _, kind := range []string{crypto.KindPassphrase, crypto.KindRecovery} {
		if v, _ := mv.db.Meta(ctx, metaEnvelopeV2(cloudID, kind)); v == "1" {
			pins[kind] = true
			m.crypto.MarkEnvelopeV2(cloudID, kind)
		}
	}
	return pins
}

// pinEnvelopeV2 records that the vault's envelope of kind is v2 on the server:
// from now on this device refuses a v1 envelope of that kind (trust on first
// use, ADR-0034).
func (m *Manager) pinEnvelopeV2(ctx context.Context, mv *managed, cloudID, kind string) {
	m.crypto.MarkEnvelopeV2(cloudID, kind)
	if err := mv.db.SetMeta(ctx, metaEnvelopeV2(cloudID, kind), "1"); err != nil {
		m.log.Warn().Err(err).Str("kind", kind).Msg("sync: pin key envelope format")
	}
}

// putEnvelope uploads a new envelope and pins its kind when it is v2.
func (m *Manager) putEnvelope(ctx context.Context, mv *managed, c *transport.Client, cloudID string, env transport.KeyEnvelope) error {
	if err := c.PutKeyEnvelope(ctx, cloudID, env); err != nil {
		return err
	}
	if vaultcrypto.EnvelopeVersion(env.WrappedVmk) == 2 {
		m.pinEnvelopeV2(ctx, mv, cloudID, string(env.Kind))
	}
	return nil
}

// uploadUpgradedEnvelope replaces an envelope with its v2 re-wrap after an
// unlock (release N+1 behavior, only while v2 writing is on). It is best
// effort: the vault is already unlocked and the old envelope still works, so
// a failure is only logged. The envelope is replaced only if it is still the
// one that was opened, so a passphrase changed meanwhile on another device is
// never overwritten with the old one.
func (m *Manager) uploadUpgradedEnvelope(ctx context.Context, mv *managed, c *transport.Client, cloudID string, opened []transport.KeyEnvelope, up transport.KeyEnvelope) {
	before, ok := findEnvelope(opened, string(up.Kind))
	if !ok {
		return
	}
	cur, err := c.GetKeyEnvelopes(ctx, cloudID)
	if err != nil {
		m.log.Warn().Err(err).Msg("sync: key envelope upgrade skipped")
		return
	}
	if now, ok := findEnvelope(cur, string(up.Kind)); !ok || !bytes.Equal(now.WrappedVmk, before.WrappedVmk) {
		return
	}
	if err := m.putEnvelope(ctx, mv, c, cloudID, up); err != nil {
		m.log.Warn().Err(err).Str("kind", string(up.Kind)).Msg("sync: key envelope upgrade failed")
	}
}

// upgradeNewVaultEnvelopes replaces the v1 envelopes a vault was just created
// with by their v2 re-wraps: v2 needs the vault id, which the server assigns
// at creation. Best effort, like uploadUpgradedEnvelope.
func (m *Manager) upgradeNewVaultEnvelopes(ctx context.Context, mv *managed, c *transport.Client, cloudID string, mat crypto.Material) {
	envs, err := m.crypto.UpgradeMaterial(cloudID, mat)
	if err != nil {
		m.log.Warn().Err(err).Msg("sync: key envelope upgrade skipped")
		return
	}
	for _, e := range envs {
		if err := m.putEnvelope(ctx, mv, c, cloudID, e); err != nil {
			m.log.Warn().Err(err).Str("kind", string(e.Kind)).Msg("sync: key envelope upgrade failed")
		}
	}
}

func findEnvelope(envs []transport.KeyEnvelope, kind string) (transport.KeyEnvelope, bool) {
	for _, e := range envs {
		if string(e.Kind) == kind {
			return e, true
		}
	}
	return transport.KeyEnvelope{}, false
}

// LockVault forgets the key on this device (memory and keychain). What waits
// for upload is pushed first (a bounded cycle: the engine cannot encrypt once
// the key is gone), and the lock waits for a running cycle to end, so the key
// never disappears halfway through applying server changes. Signing in is not
// needed: offline, the changes simply stay in the outbox.
func (m *Manager) LockVault(ctx context.Context, localID string) error {
	mv, err := m.linked(localID)
	if err != nil {
		return err
	}
	if mv.kind != "private" {
		return errors.New("only private vaults are encrypted")
	}
	cloud := mv.cloudID
	return m.drainAndLock(ctx, cloud, LockReasonManual, func() (bool, error) {
		return true, m.crypto.Lock(cloud)
	})
}

// Reasons carried by EventLocked.
const (
	// LockReasonManual: the user locked the vault.
	LockReasonManual = "manual"
	// LockReasonIdle: the idle timeout expired.
	LockReasonIdle = "idle"
	// LockReasonSync: a synchronization cycle found the vault without its key
	// (no key in the keychain at startup, or locked since the last cycle).
	LockReasonSync = "sync"
)

// LockedEvent is the payload of EventLocked, computed after the key is gone.
// Pending counts the files that still differ from the server (they stay in
// the outbox and leave at the next unlock); -1 means unknown (the local
// changes could not be scanned), so the clear-text copy must be kept.
type LockedEvent struct {
	VaultID   string `json:"vaultId"`
	Reason    string `json:"reason"`
	Pending   int    `json:"pending"`
	Conflicts int    `json:"conflicts"`
}

// drainTimeout bounds the cycle that pushes pending changes before a lock.
const drainTimeout = 20 * time.Second

// lockedViews returns the linked vaults that use the key of a cloud vault,
// in a stable order (their cycle locks are taken in that order).
func (m *Manager) lockedViews(cloud string) []linkView {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []linkView
	for _, mv := range m.vaults {
		if mv.engine != nil && mv.cloudID == cloud {
			out = append(out, linkView{managed: mv, engine: mv.engine, cloudID: mv.cloudID, kind: mv.kind, scope: mv.scope})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].localID < out[j].localID })
	return out
}

// drain runs one bounded cycle so the changes waiting for upload leave while
// the key is still there. Failures (offline, timeout) are fine: what is not
// pushed stays in the outbox and is reported as pending.
func (m *Manager) drain(ctx context.Context, v linkView) {
	if _, ok := m.session.Info(); !ok {
		return
	}
	dctx, cancel := context.WithTimeout(ctx, drainTimeout)
	defer cancel()
	if err := v.engine.Sync(dctx); err != nil && !errors.Is(err, ErrPaused) {
		m.log.Info().Err(err).Str("vault", v.localID).Msg("sync: changes left in the outbox at lock")
	}
}

// drainAndLock pushes what waits for upload, then, holding every engine that
// uses the key, records the local changes no cycle has seen (a scan needs no
// key) and calls lock. When lock removed the key the UI is told, with what
// is left to push. lock reports whether the key left memory.
func (m *Manager) drainAndLock(ctx context.Context, cloud, reason string, lock func() (bool, error)) error {
	views := m.lockedViews(cloud)
	for _, v := range views {
		m.drain(ctx, v)
	}
	scanErrs := make([]error, len(views))
	var locked bool
	var lockErr error
	var hold func(i int) error
	hold = func(i int) error {
		if i == len(views) {
			locked, lockErr = lock()
			return nil
		}
		eng := views[i].engine
		return eng.Exclusive(func() error {
			scanErrs[i] = eng.scan(ctx)
			return hold(i + 1)
		})
	}
	_ = hold(0)
	if !locked {
		return lockErr
	}
	for i, v := range views {
		m.emit(EventLocked, m.lockedEvent(ctx, v.localID, v.engine, v.db, reason, scanErrs[i]))
	}
	return lockErr
}

// lockedEvent counts what a locked vault still has to push and its open
// conflicts (sync.db alone, no key needed) and puts the engine in PhaseLocked.
func (m *Manager) lockedEvent(ctx context.Context, localID string, eng *Engine, db *DB, reason string, scanErr error) LockedEvent {
	ev := LockedEvent{VaultID: localID, Reason: reason}
	var err error
	if ev.Pending, err = db.PendingCount(ctx); err != nil || scanErr != nil {
		m.log.Warn().Err(errors.Join(err, scanErr)).Str("vault", localID).Msg("sync: pending changes of a locked vault unknown")
		ev.Pending = -1
	}
	ev.Conflicts, _ = db.OpenConflictCount(ctx)
	eng.setStatus(func(s *Status) {
		s.Phase, s.Error, s.Done, s.Total = PhaseLocked, "", 0, 0
		s.Pending, s.Conflicts = max(ev.Pending, 0), ev.Conflicts
	})
	return ev
}

// Activity records user activity: the idle timer of the unlocked private
// vaults starts again. The sync engine's own work never counts.
func (m *Manager) Activity() { m.crypto.Touch() }

// ChangePassphrase re-wraps the VMK under a new passphrase; nothing is re-encrypted.
func (m *Manager) ChangePassphrase(ctx context.Context, localID, oldPassphrase, newPassphrase string) error {
	mv, c, err := m.privateVault(localID)
	if err != nil {
		return err
	}
	envs, err := c.GetKeyEnvelopes(ctx, mv.cloudID)
	if err != nil {
		return err
	}
	if err := m.crypto.VerifyPassphrase(mv.cloudID, envs, oldPassphrase); err != nil {
		return err
	}
	return m.putNewPassphrase(ctx, mv, c, newPassphrase)
}

// SetPassphrase sets a new passphrase on an unlocked vault without asking for
// the old one: the step that follows an unlock with the recovery key.
func (m *Manager) SetPassphrase(ctx context.Context, localID, newPassphrase string) error {
	mv, c, err := m.privateVault(localID)
	if err != nil {
		return err
	}
	return m.putNewPassphrase(ctx, mv, c, newPassphrase)
}

func (m *Manager) putNewPassphrase(ctx context.Context, mv linkView, c *transport.Client, newPassphrase string) error {
	m.envelopePins(ctx, mv.managed, mv.cloudID)
	env, err := m.crypto.NewPassphraseEnvelope(mv.cloudID, newPassphrase)
	if err != nil {
		return err
	}
	return m.putEnvelope(ctx, mv.managed, c, mv.cloudID, env)
}

// RegenerateRecoveryKey issues a new recovery key (the old one stops working)
// after checking the passphrase; the text is shown once.
func (m *Manager) RegenerateRecoveryKey(ctx context.Context, localID, passphrase string) (string, error) {
	mv, c, err := m.privateVault(localID)
	if err != nil {
		return "", err
	}
	envs, err := c.GetKeyEnvelopes(ctx, mv.cloudID)
	if err != nil {
		return "", err
	}
	if err := m.crypto.VerifyPassphrase(mv.cloudID, envs, passphrase); err != nil {
		return "", err
	}
	m.envelopePins(ctx, mv.managed, mv.cloudID)
	env, key, err := m.crypto.NewRecoveryEnvelope(mv.cloudID)
	if err != nil {
		return "", err
	}
	return key, m.putEnvelope(ctx, mv.managed, c, mv.cloudID, env)
}

// --- conflicts ---------------------------------------------------------------

// Conflicts lists the unresolved conflicts of a vault.
func (m *Manager) Conflicts(ctx context.Context, localID string) ([]Conflict, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return nil, err
	}
	return mv.db.Conflicts(ctx, "open")
}

// ConflictAction is how the user settles a conflict.
type ConflictAction string

// Actions of the resolution view.
const (
	KeepRemote ConflictAction = "keep-remote" // the path keeps the server version; our copy is deleted
	KeepLocal  ConflictAction = "keep-local"  // our version replaces the path; the copy is deleted
	KeepBoth   ConflictAction = "keep-both"   // both stay as separate files
	UseMerged  ConflictAction = "merged"      // the user's merged text replaces the path; the copy is deleted
)

// ResolveConflict applies the user's choice to the files and closes the record.
func (m *Manager) ResolveConflict(ctx context.Context, localID string, id int64, action ConflictAction, merged string) error {
	mv, err := m.linked(localID)
	if err != nil {
		return err
	}
	all, err := mv.db.Conflicts(ctx, "open")
	if err != nil {
		return err
	}
	var c *Conflict
	for i := range all {
		if all[i].ID == id {
			c = &all[i]
		}
	}
	if c == nil {
		return errors.New("conflict not found or already resolved")
	}
	err = mv.engine.Exclusive(func() error {
		trash := func(p string) error {
			if p == "" {
				return nil
			}
			if _, err := mv.fs.Trash(p); err != nil && !os.IsNotExist(err) {
				return err
			}
			return nil
		}
		switch action {
		case KeepRemote:
			return trash(c.CopyPath)
		case KeepLocal:
			cp, err := mv.fs.ReadFile(c.CopyPath)
			if err != nil {
				return fmt.Errorf("the saved copy is gone: %w", err)
			}
			if _, err := mv.fs.WriteFile(c.Path, cp.Data, "", false); err != nil {
				return err
			}
			return trash(c.CopyPath)
		case UseMerged:
			if _, err := mv.fs.WriteFile(c.Path, []byte(merged), "", false); err != nil {
				return err
			}
			return trash(c.CopyPath)
		case KeepBoth:
			return nil
		default:
			return fmt.Errorf("unknown action %q", action)
		}
	})
	if err != nil {
		return err
	}
	status := "resolved"
	if action == KeepBoth {
		status = "dismissed"
	}
	if err := mv.db.SetConflictStatus(ctx, id, status); err != nil {
		return err
	}
	m.Kick(localID)
	return nil
}

// ConflictTexts returns the two versions of a conflict for the side-by-side view.
func (m *Manager) ConflictTexts(ctx context.Context, localID string, id int64) (current, ours string, err error) {
	mv, err := m.linked(localID)
	if err != nil {
		return "", "", err
	}
	all, err := mv.db.Conflicts(ctx, "open")
	if err != nil {
		return "", "", err
	}
	for _, c := range all {
		if c.ID != id {
			continue
		}
		cur, err := mv.fs.ReadFile(c.Path)
		if err != nil {
			return "", "", err
		}
		cp, err := mv.fs.ReadFile(c.CopyPath)
		if err != nil {
			return "", "", err
		}
		return string(cur.Data), string(cp.Data), nil
	}
	return "", "", errors.New("conflict not found")
}

// --- history -----------------------------------------------------------------

// RevisionInfo is one entry of a note's history.
type RevisionInfo struct {
	Rev        int       `json:"rev"`
	Op         string    `json:"op"`
	Path       string    `json:"path"`
	Size       int64     `json:"size"`
	AuthorID   string    `json:"authorId"`
	DeviceID   string    `json:"deviceId"`
	Time       time.Time `json:"time"`
	HasContent bool      `json:"hasContent"`
	Mine       bool      `json:"mine"`
}

func (m *Manager) fileOf(ctx context.Context, localID, path string) (linkView, File, *transport.Client, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return linkView{}, File{}, nil, err
	}
	row, ok, err := mv.db.GetFile(ctx, path)
	if err != nil {
		return linkView{}, File{}, nil, err
	}
	if !ok || row.ServerRev == 0 {
		return linkView{}, File{}, nil, errors.New("this note has not been uploaded yet: it has no history")
	}
	c, _, err := m.client()
	return mv, row, c, err
}

// History lists the revisions of a note, newest first.
func (m *Manager) History(ctx context.Context, localID, path string) ([]RevisionInfo, error) {
	mv, row, c, err := m.fileOf(ctx, localID, path)
	if err != nil {
		return nil, err
	}
	info, _ := m.session.Info()
	revs, _, err := c.ListRevisions(ctx, transport.Ref(mv.cloudID, mv.scope), row.FileID, 200, "")
	if err != nil {
		return nil, err
	}
	out := make([]RevisionInfo, 0, len(revs))
	for _, r := range revs {
		p := r.Path
		if mv.engine.cfg.Cipher != nil {
			if dec, err := mv.engine.cfg.Cipher.DecryptPath(r.Path); err == nil {
				p = dec
			} else {
				p = ""
			}
		}
		out = append(out, RevisionInfo{Rev: r.Rev, Op: r.Op, Path: p, Size: r.Size, AuthorID: r.AuthorID, DeviceID: r.DeviceID, Time: r.ServerTime, HasContent: r.BlobHash != "", Mine: r.AuthorID == info.UserID})
	}
	return out, nil
}

// MaxHistoryText bounds the revisions loaded into the diff view.
const MaxHistoryText = 5 << 20

// RevisionText returns the (decrypted) text of a revision.
func (m *Manager) RevisionText(ctx context.Context, localID, path string, rev int) (string, error) {
	mv, row, _, err := m.fileOf(ctx, localID, path)
	if err != nil {
		return "", err
	}
	data, err := mv.engine.fetchRevision(ctx, row.FileID, rev)
	if err != nil {
		return "", err
	}
	if len(data) > MaxHistoryText {
		return "", errors.New("this revision is too large to show")
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "", errors.New("this revision is binary")
	}
	return string(data), nil
}

// RestoreRevision restores a revision as a new one and brings it down.
func (m *Manager) RestoreRevision(ctx context.Context, localID, path string, rev int) error {
	mv, row, c, err := m.fileOf(ctx, localID, path)
	if err != nil {
		return err
	}
	res, err := c.RestoreRevision(ctx, transport.Ref(mv.cloudID, mv.scope), row.FileID, rev)
	if err != nil {
		return err
	}
	if res.Status != "accepted" {
		return fmt.Errorf("%s: %s", res.Code, res.Detail)
	}
	m.kickNow(mv.managed)
	return nil
}

// Devices lists the account's devices.
func (m *Manager) Devices(ctx context.Context) ([]transport.Device, error) {
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	return c.ListDevices(ctx)
}

// RevokeDevice revokes a device of the account.
func (m *Manager) RevokeDevice(ctx context.Context, id string) error {
	c, _, err := m.client()
	if err != nil {
		return err
	}
	return c.RevokeDevice(ctx, id)
}

// Usage returns the storage usage of the account.
func (m *Manager) Usage(ctx context.Context) (transport.Usage, error) {
	c, _, err := m.client()
	if err != nil {
		return transport.Usage{}, err
	}
	return c.GetUsage(ctx)
}

var _ = strconv.Itoa
