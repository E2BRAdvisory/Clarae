package sync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"nodus/apps/desktop/internal/crypto"
	"nodus/apps/desktop/internal/sync/transport"
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
	if mv.engine == nil {
		return Status{VaultID: localID, Phase: PhaseIdle}, nil
	}
	st := mv.engine.Status()
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
		MetaCloudVault: v.ID, MetaKind: v.Kind, MetaServerURL: info.ServerURL, MetaDeviceID: info.DeviceID,
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
	switch kind {
	case "shared":
		v, err = c.CreateVault(ctx, name, "shared", nil)
	case "private":
		var mat crypto.Material
		if mat, err = m.crypto.NewMaterial(passphrase); err != nil {
			return LinkResult{}, err
		}
		if v, err = c.CreateVault(ctx, name, "private", mat.Envelopes); err != nil {
			return LinkResult{}, err
		}
		if err = m.crypto.Adopt(v.ID, mat); err != nil {
			return LinkResult{}, err
		}
		res.RecoveryKey = mat.RecoveryKey
	default:
		return LinkResult{}, fmt.Errorf("unknown vault kind %q", kind)
	}
	if err != nil {
		return LinkResult{}, err
	}
	res.CloudVaultID = v.ID
	if err := m.saveLink(ctx, mv, v, info); err != nil {
		return res, err
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
	m.stopLocked(mv)
	cloud, kind := mv.cloudID, mv.kind
	mv.engine, mv.cloudID, mv.kind, mv.scope = nil, "", "", ""
	m.mu.Unlock()
	if cloud != "" && kind == "private" {
		_ = m.crypto.Forget(cloud)
	}
	for _, k := range []string{MetaCloudVault, MetaKind, MetaServerURL, MetaDeviceID, MetaUserID, MetaVaultName, MetaBootstrapped, MetaPaused, MetaLinkedAt, MetaScope, MetaPermission, MetaShareID, MetaMountName, MetaOwnerName, MetaResourceType, MetaRevoked} {
		_ = mv.db.DeleteMeta(ctx, k)
	}
	if _, err := mv.sdb.ExecContext(ctx, `DELETE FROM sync_files; DELETE FROM outbox; DELETE FROM conflicts; UPDATE sync_cursor SET last_seq = 0`); err != nil {
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
		m.kickNow(mv)
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
	m.kickNow(mv)
	return nil
}

// SyncNow requests an immediate synchronization.
func (m *Manager) SyncNow(localID string) error {
	mv, err := m.linked(localID)
	if err != nil {
		return err
	}
	m.startLoop(mv)
	m.kickNow(mv)
	return nil
}

// --- encryption --------------------------------------------------------------

func (m *Manager) privateVault(localID string) (*managed, *transport.Client, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return nil, nil, err
	}
	if mv.kind != "private" {
		return nil, nil, errors.New("only private vaults are encrypted")
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
	if requiresNewPassphrase, err = m.crypto.Unlock(mv.cloudID, envs, secret, recovery); err != nil {
		return false, err
	}
	m.kickNow(mv)
	return requiresNewPassphrase, nil
}

// LockVault forgets the key on this device (memory and keychain).
func (m *Manager) LockVault(ctx context.Context, localID string) error {
	mv, _, err := m.privateVault(localID)
	if err != nil {
		return err
	}
	if err := m.crypto.Lock(mv.cloudID); err != nil {
		return err
	}
	mv.engine.setStatus(func(s *Status) { s.Phase, s.Error = PhaseLocked, "" })
	m.emit(EventLocked, map[string]any{"vaultId": localID})
	return nil
}

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
	if err := m.crypto.VerifyPassphrase(envs, oldPassphrase); err != nil {
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

func (m *Manager) putNewPassphrase(ctx context.Context, mv *managed, c *transport.Client, newPassphrase string) error {
	env, err := m.crypto.NewPassphraseEnvelope(mv.cloudID, newPassphrase)
	if err != nil {
		return err
	}
	return c.PutKeyEnvelope(ctx, mv.cloudID, env)
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
	if err := m.crypto.VerifyPassphrase(envs, passphrase); err != nil {
		return "", err
	}
	env, key, err := m.crypto.NewRecoveryEnvelope(mv.cloudID)
	if err != nil {
		return "", err
	}
	return key, c.PutKeyEnvelope(ctx, mv.cloudID, env)
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

func (m *Manager) fileOf(ctx context.Context, localID, path string) (*managed, File, *transport.Client, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return nil, File{}, nil, err
	}
	row, ok, err := mv.db.GetFile(ctx, path)
	if err != nil {
		return nil, File{}, nil, err
	}
	if !ok || row.ServerRev == 0 {
		return nil, File{}, nil, errors.New("this note has not been uploaded yet: it has no history")
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
	m.kickNow(mv)
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
