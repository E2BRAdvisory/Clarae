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
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/vaultcrypto"
)

// LinkResult is returned when a vault is connected to the cloud.
type LinkResult struct {
	CloudVaultID string `json:"cloudVaultId"`
	// RecoveryKey is set for private vaults and shown to the user exactly once.
	RecoveryKey string `json:"recoveryKey"`
	// Warning, when set, is one of the Warn* codes: the link succeeded with
	// a limitation the user should be told about.
	Warning string `json:"warning,omitempty"`
}

// Info returns the cloud connection of a vault. It is for the screens, which show what they can: a value of the
// meta table that cannot be read is left out (a link whose cloud vault cannot be read is shown as not linked).
// A decision that depends on the answer, such as who may see the text of a vault, uses InfoStrict.
func (m *Manager) Info(ctx context.Context, localID string) (LinkInfo, error) {
	mv, err := m.get(localID)
	if err != nil {
		return LinkInfo{}, err
	}
	info, _ := m.readInfo(ctx, mv)
	return info, nil
}

// InfoStrict is Info that reports a failure to read the meta table instead of hiding it: the error is returned
// with an empty LinkInfo, never a partial one. An unreadable table is not "not linked" (Info says so) and not
// "shared" either: the caller must treat it as unknown (the assistant of the editor fails closed on it).
func (m *Manager) InfoStrict(ctx context.Context, localID string) (LinkInfo, error) {
	mv, err := m.get(localID)
	if err != nil {
		return LinkInfo{}, err
	}
	info, err := m.readInfo(ctx, mv)
	if err != nil {
		return LinkInfo{}, fmt.Errorf("read the link of vault %s: %w", localID, err)
	}
	return info, nil
}

// readInfo reads the link of a vault from its meta table. It reads everything it can and returns the first
// error it met next to what it got: Info drops the error, InfoStrict returns it. Without the cloud vault it
// stops (nothing else says anything about a vault that is not linked), and with an error there it cannot tell
// whether the vault is linked.
func (m *Manager) readInfo(ctx context.Context, mv *managed) (LinkInfo, error) {
	var first error
	note := func(err error) {
		if first == nil {
			first = err
		}
	}
	cloud, err := mv.db.Meta(ctx, MetaCloudVault)
	if err != nil {
		return LinkInfo{}, err
	}
	if cloud == "" {
		return LinkInfo{}, nil
	}
	meta := func(key string) string {
		v, err := mv.db.Meta(ctx, key)
		note(err)
		return v
	}
	kind := meta(MetaKind)
	name := meta(MetaVaultName)
	server := meta(MetaServerURL)
	paused := meta(MetaPaused)
	poll, err := mv.db.MetaInt(ctx, MetaPollSeconds)
	note(err)
	info := LinkInfo{PollSeconds: poll, Linked: true, CloudVaultID: cloud, Kind: kind, Name: name, ServerURL: server, Paused: paused == "1", Locked: kind == "private" && m.crypto.IsLocked(cloud), Permission: PermOwner}
	mm, ok, err := readMountMeta(ctx, mv.db)
	note(err)
	if ok {
		info.Mount, info.Permission, info.Revoked = true, mm.Permission, mm.Revoked
		info.ReadOnly = mm.Revoked || mm.Permission == PermViewer
		info.OwnerName, info.ShareID, info.Name = mm.OwnerName, mm.ShareID, mm.Name
	}
	return info, first
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
	return m.view(eng.Status()), nil
}

// view is an engine status as the UI must read it: while signed out an idle
// engine is offline, and while the device is revoked every engine says so (a
// cycle cancelled by the stop would otherwise end on a plain idle).
func (m *Manager) view(st Status) Status {
	if info, ok := m.session.Info(); !ok {
		switch {
		case info.DeviceRevoked:
			st = revokedView(st)
		case st.Phase == PhaseIdle:
			st.Phase, st.Error = PhaseOffline, "signed out of the cloud"
		}
	}
	return st
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
//
// Once a private vault exists on the server its recovery key is the only
// way back to the data if the passphrase is forgotten, so it is never
// dropped: a keychain that cannot store the key only makes the unlock last
// for this session (Warning), and a step that fails before the link is saved
// deletes the server vault again. Should that delete fail too, Link still
// succeeds with the recovery key and the server vault left unlinked
// (WarnLinkIncomplete): the folder can be connected to it later.
func (m *Manager) Link(ctx context.Context, localID, name, kind, passphrase string) (LinkResult, error) {
	if kind == "private" {
		// The passphrase policy first: a weak passphrase is refused for what
		// it is, signed in or not (NewMaterial checks it again).
		if err := crypto.ValidatePassphrase(passphrase); err != nil {
			return LinkResult{}, err
		}
	}
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
		if v, err = c.CreateVault(ctx, name, "shared", nil); err != nil {
			return LinkResult{}, err
		}
	case "private":
		if mat, err = m.crypto.NewMaterial(passphrase); err != nil {
			return LinkResult{}, err
		}
		// Adopt copies the VMK and UpgradeMaterial runs before Link returns:
		// the material's keys are not needed past this call.
		defer mat.Wipe()
		if v, err = c.CreateVault(ctx, name, "private", mat.Envelopes); err != nil {
			return LinkResult{}, err
		}
		res.RecoveryKey = mat.RecoveryKey
	default:
		return LinkResult{}, fmt.Errorf("unknown vault kind %q", kind)
	}
	res.CloudVaultID = v.Id.String()
	if kind == "private" {
		if err := m.crypto.Adopt(res.CloudVaultID, mat); err != nil {
			if m.crypto.IsLocked(res.CloudVaultID) {
				return m.undoLink(ctx, c, res, err)
			}
			// The key is active in memory, only the keychain refused it:
			// the vault works now and asks for the passphrase next start.
			m.log.Warn().Err(err).Str("vault", localID).Msg("sync: vault key not saved in the keychain")
			res.Warning = WarnKeychainUnavailable
		}
	}
	if err := m.saveLink(ctx, mv, v, info); err != nil {
		if kind == "private" {
			_ = m.crypto.Forget(res.CloudVaultID)
		}
		return m.undoLink(ctx, c, res, err)
	}
	if kind == "private" && m.crypto.EnvelopeV2() {
		m.upgradeNewVaultEnvelopes(ctx, mv, c, res.CloudVaultID, mat)
	}
	if err := m.activate(ctx, mv); err != nil {
		if res.RecoveryKey == "" {
			return res, err
		}
		// The link is saved and activated again at the next start: the
		// recovery key, shown only now, matters more than this error.
		m.log.Error().Err(err).Str("vault", localID).Msg("sync: start after link")
		return res, nil
	}
	m.kickNow(mv)
	return res, nil
}

// Warnings of a LinkResult.
const (
	// WarnKeychainUnavailable: the vault key could not be kept in the OS
	// keychain; the vault is unlocked for this session only.
	WarnKeychainUnavailable = "keychain-unavailable"
	// WarnLinkIncomplete: the private vault exists on the server but this
	// folder could not be linked to it; connect it with LinkExisting.
	WarnLinkIncomplete = "link-incomplete"
)

// undoLink deletes the cloud vault Link has just created after a later step
// failed (cause). A private vault the server keeps anyway is reported with its
// recovery key instead of the error, so the key is never lost.
func (m *Manager) undoLink(ctx context.Context, c *transport.Client, res LinkResult, cause error) (LinkResult, error) {
	derr := c.DeleteVault(context.WithoutCancel(ctx), res.CloudVaultID)
	if derr == nil {
		return LinkResult{}, cause
	}
	m.log.Error().Err(cause).AnErr("rollback", derr).Str("cloudVault", res.CloudVaultID).Msg("sync: link failed and the new cloud vault could not be deleted")
	if res.RecoveryKey == "" {
		return LinkResult{}, cause
	}
	res.Warning = WarnLinkIncomplete
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
	return m.unlink(ctx, mv)
}

// unlink is Unlink of an open vault. It waits for the vault's loop: never call it from the loop.
func (m *Manager) unlink(ctx context.Context, mv *managed) error {
	m.mu.Lock()
	done := m.stopLocked(mv)
	cloud, kind, eng := mv.cloudID, mv.kind, mv.engine
	mv.engine, mv.cloudID, mv.kind, mv.scope = nil, "", "", ""
	m.mu.Unlock()
	waitLoop(done) // no cycle of the loop may write the state erased below
	reset := func() error {
		for _, k := range []string{MetaCloudVault, MetaKind, MetaServerURL, MetaDeviceID, MetaUserID, MetaVaultName, MetaBootstrapped, MetaPaused, MetaLinkedAt, MetaLastScan, MetaScope, MetaPermission, MetaShareID, MetaMountName, MetaOwnerName, MetaResourceType, MetaRevoked} {
			_ = mv.db.DeleteMeta(ctx, k)
		}
		_, err := mv.sdb.ExecContext(ctx, resetSQL)
		return err
	}
	if cloud != "" && kind == "private" {
		_ = m.crypto.Forget(cloud) // a cycle still running stops at its next use of the key
	}
	var err error
	if eng != nil {
		// Nor a cycle started outside the loop (the drain before a lock, which
		// holds the engine it captured earlier): the reset waits for it, and
		// the engine refuses every later one.
		err = eng.retire(reset)
	} else {
		err = reset()
	}
	if err != nil {
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

// SyncNow requests an immediate synchronization that sees the disk as it is
// now: a cycle whose scan starts after the call (Engine.RequestScan). Until it
// has completed the status says syncing, never a stale idle. Requests made while
// a cycle runs coalesce: at most one more cycle follows, and none when a later
// round of the running cycle already scanned. A revoked device does not sync.
func (m *Manager) SyncNow(localID string) error {
	mv, err := m.linked(localID)
	if err != nil {
		return err
	}
	if info, ok := m.session.Info(); !ok && info.DeviceRevoked {
		return ErrDeviceRevoked
	}
	mv.engine.RequestScan()
	m.startLoop(mv.managed)
	select {
	case mv.req <- struct{}{}:
	default:
	}
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
	wasLocked := m.crypto.IsLocked(mv.cloudID)
	res, err := m.crypto.UnlockWith(mv.cloudID, envs, secret, recovery, crypto.UnlockOptions{PinnedV2: m.envelopePins(ctx, mv.managed, mv.cloudID)})
	if err != nil {
		if !wasLocked || m.crypto.IsLocked(mv.cloudID) {
			return false, err
		}
		// Unlocked in memory, only the keychain refused the key: the vault
		// works for this session and asks again at the next start.
		m.log.Warn().Err(err).Str("vault", localID).Msg("sync: vault key not saved in the keychain")
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

// LockReason says why EventLocked was sent.
type LockReason string

// Reasons carried by EventLocked.
const (
	// LockReasonManual: the user locked the vault.
	LockReasonManual LockReason = "manual"
	// LockReasonIdle: the idle timeout expired.
	LockReasonIdle LockReason = "idle"
	// LockReasonSync: a synchronization cycle found the vault without its key
	// (no key in the keychain at startup, or locked since the last cycle).
	LockReasonSync LockReason = "sync"
)

// LockedEvent is the payload of EventLocked, computed after the key is gone.
// Pending counts the files that still differ from the server (they stay in
// the outbox and leave at the next unlock); -1 means unknown (the local
// changes could not be scanned), so the clear-text copy must be kept.
type LockedEvent struct {
	VaultID   string     `json:"vaultId"`
	Reason    LockReason `json:"reason"`
	Pending   int        `json:"pending"`
	Conflicts int        `json:"conflicts"`
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
	if err := v.engine.Sync(dctx); err != nil && !errors.Is(err, ErrPaused) && !errors.Is(err, ErrUnlinked) {
		m.log.Info().Err(err).Str("vault", v.localID).Msg("sync: changes left in the outbox at lock")
	}
}

// drainAndLock pushes what waits for upload, then, holding every engine that
// uses the key, records the local changes no cycle has seen (a scan needs no
// key) and calls lock. When lock removed the key the UI is told, with what
// is left to push. lock reports whether the key left memory.
func (m *Manager) drainAndLock(ctx context.Context, cloud string, reason LockReason, lock func() (bool, error)) error {
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
		err := eng.Exclusive(func() error {
			scanErrs[i] = eng.scan(ctx)
			return hold(i + 1)
		})
		if errors.Is(err, ErrUnlinked) {
			scanErrs[i] = err // unlinked since the views were taken: nothing to hold
			return hold(i + 1)
		}
		return err
	}
	_ = hold(0)
	if !locked {
		return lockErr
	}
	for i, v := range views {
		if errors.Is(scanErrs[i], ErrUnlinked) {
			continue
		}
		EventLocked.Send(m.emit, m.lockedEvent(ctx, v.localID, v.engine, v.db, reason, scanErrs[i]))
	}
	return lockErr
}

// lockedEvent counts what a locked vault still has to push and its open
// conflicts (sync.db alone, no key needed) and puts the engine in PhaseLocked.
func (m *Manager) lockedEvent(ctx context.Context, localID string, eng *Engine, db *DB, reason LockReason, scanErr error) LockedEvent {
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
// The new passphrase must meet the policy (crypto.ValidatePassphrase), the old
// one only has to open the vault.
func (m *Manager) ChangePassphrase(ctx context.Context, localID, oldPassphrase, newPassphrase string) error {
	if err := crypto.ValidatePassphrase(newPassphrase); err != nil {
		return err // before the network and the slow check of the old one
	}
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
	if err := crypto.ValidatePassphrase(newPassphrase); err != nil {
		return err
	}
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

// ErrConflictChanged means the file of a conflict changed (or was moved away
// or deleted) since its versions were shown: the choice is not applied, the
// user must look at the conflict again.
var ErrConflictChanged = errors.New("the file changed since this conflict was shown: review it again")

// ConflictView is what the resolution view shows of a conflict.
type ConflictView struct {
	Current     string // what the file holds now (the server version, unless edited since)
	Ours        string // what this device had (the saved copy)
	CurrentHash string // digest of Current: what ResolveConflict may replace
}

// conflictFile returns the current row of a conflict's file, wherever it was
// moved since the conflict was recorded. ok is false when the file no longer
// exists here (deleted, or no longer synchronized).
func conflictFile(ctx context.Context, mv linkView, c Conflict) (File, bool, error) {
	row, ok, err := mv.db.GetFileByID(ctx, c.FileID)
	if err != nil || !ok {
		return File{}, false, err
	}
	return row, row.State != StateLocalDeleted, nil
}

func shownKey(localID string, id int64) string { return localID + "/" + strconv.FormatInt(id, 10) }

// ResolveConflict applies the user's choice to the files and closes the record.
// keep-local and merged replace the file only while it holds expectedHash, the
// content the user was shown ("" for the one the last ConflictTexts of this
// conflict returned); otherwise they fail with ErrConflictChanged and write
// nothing. Without either, only a file that holds exactly what the server has
// is replaced (nothing can be lost). The file is followed through renames, is
// never brought back once deleted, and what it held is snapshotted in the
// local history first.
func (m *Manager) ResolveConflict(ctx context.Context, localID string, id int64, action ConflictAction, merged, expectedHash string) error {
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
	if expectedHash == "" {
		m.mu.Lock()
		expectedHash = m.shown[shownKey(localID, id)]
		m.mu.Unlock()
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
		replace := func(data []byte) error {
			row, ok, err := conflictFile(ctx, mv, *c)
			if err != nil {
				return err
			}
			if !ok {
				return ErrConflictChanged
			}
			expected := expectedHash
			if expected == "" {
				// Nothing tells what the user saw: only content the server
				// has may be replaced (a plaintext digest proves it in a
				// shared vault only).
				onServer := row.State == StateSynced || (row.State == StateLocalMoved && !row.Dirty) ||
					(mv.engine.cfg.Cipher == nil && !row.Tombstoned && row.LocalHash == row.ServerHash)
				if !onServer {
					return ErrConflictChanged
				}
				expected = row.LocalHash
			}
			h, _, err := mv.fs.HashFile(row.Path)
			switch {
			case err == nil && h == hashHex(data):
				return nil // already done (a resolution retried after its copy could not be removed)
			case err != nil || h != expected:
				return ErrConflictChanged
			}
			if hook := mv.engine.cfg.BeforeOverwrite; hook != nil {
				hook(row.Path)
			}
			if _, err := mv.fs.WriteFile(row.Path, data, expected, false); err != nil {
				if errors.Is(err, vault.ErrHashMismatch) {
					return ErrConflictChanged
				}
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
			if err := replace(cp.Data); err != nil {
				return err
			}
			return trash(c.CopyPath)
		case UseMerged:
			if err := replace([]byte(merged)); err != nil {
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
	m.mu.Lock()
	delete(m.shown, shownKey(localID, id))
	m.mu.Unlock()
	m.Kick(localID)
	return nil
}

// ConflictTexts returns the two versions of a conflict for the side-by-side
// view, the current one read where the file is now. Its digest is remembered
// as what ResolveConflict may replace.
func (m *Manager) ConflictTexts(ctx context.Context, localID string, id int64) (ConflictView, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return ConflictView{}, err
	}
	all, err := mv.db.Conflicts(ctx, "open")
	if err != nil {
		return ConflictView{}, err
	}
	for _, c := range all {
		if c.ID != id {
			continue
		}
		row, ok, err := conflictFile(ctx, mv, c)
		if err != nil {
			return ConflictView{}, err
		}
		if !ok {
			// Whatever holds the old path now is another file.
			return ConflictView{}, errors.New("the file of this conflict was deleted")
		}
		cur, err := mv.fs.ReadFile(row.Path)
		if err != nil {
			return ConflictView{}, err
		}
		cp, err := mv.fs.ReadFile(c.CopyPath)
		if err != nil {
			return ConflictView{}, err
		}
		m.mu.Lock()
		if m.shown == nil {
			m.shown = map[string]string{}
		}
		m.shown[shownKey(localID, id)] = cur.Hash
		m.mu.Unlock()
		return ConflictView{Current: string(cur.Data), Ours: string(cp.Data), CurrentHash: cur.Hash}, nil
	}
	return ConflictView{}, errors.New("conflict not found")
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
			if dec, err := mv.engine.cfg.Cipher.DecryptFilePath(row.FileID, r.Path); err == nil { // enc1 or enc2 (ADR-0042)
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
