// Package crypto is the desktop side of end-to-end encryption (§2.5 "crypto",
// §3.8): it creates the key material of private vaults, unlocks them with the
// passphrase or the recovery key, keeps the VMK in memory (and in the OS
// keychain) and exposes it to the sync engine as a Cipher. The primitives and
// formats live in shared/go/vaultcrypto.
package crypto

import (
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/vaultcrypto"
)

// MinPassphraseLength is the shortest accepted passphrase (§3.8.2). The UI also
// enforces a strength estimate (zxcvbn >= 3); the length is the hard floor.
const MinPassphraseLength = 12

// Errors.
var (
	ErrWrongSecret     = errors.New("wrong passphrase or recovery key")
	ErrShortPassphrase = fmt.Errorf("the passphrase must have at least %d characters", MinPassphraseLength)
	ErrNoEnvelope      = errors.New("the vault has no matching key envelope")
	ErrLocked          = errors.New("vault is locked")
)

// Envelope kinds.
const (
	KindPassphrase = "passphrase"
	KindRecovery   = "recovery"
)

type unlocked struct {
	sub     vaultcrypto.Subkeys
	vmk     vaultcrypto.VMK
	vaultID [16]byte
	used    time.Time
}

// Manager holds the unlocked vaults.
type Manager struct {
	store KeyStore
	now   func() time.Time

	mu       sync.Mutex
	vaults   map[string]*unlocked // cloud vault id
	timeout  time.Duration        // 0 = never
	remember bool
	// kdfTarget calibrates Argon2id on this device.
	kdfTarget time.Duration
}

// Options configure the manager.
type Options struct {
	Store KeyStore // default: OS keychain
	Now   func() time.Time
	// LockTimeout locks a vault after this much idle time (0 = never).
	LockTimeout time.Duration
	// Remember keeps the VMK in the keychain after unlock (default true).
	DontRemember bool
	// KDFTarget is the Argon2id duration to calibrate to (default 500 ms).
	KDFTarget time.Duration
}

// NewManager creates a manager.
func NewManager(o Options) *Manager {
	if o.Store == nil {
		o.Store = KeychainStore{}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.KDFTarget == 0 {
		o.KDFTarget = 500 * time.Millisecond
	}
	return &Manager{store: o.Store, now: o.Now, vaults: map[string]*unlocked{}, timeout: o.LockTimeout, remember: !o.DontRemember, kdfTarget: o.KDFTarget}
}

// SetLockTimeout changes the idle timeout (0 = never).
func (m *Manager) SetLockTimeout(d time.Duration) {
	m.mu.Lock()
	m.timeout = d
	m.mu.Unlock()
}

// LockTimeout returns the idle timeout in force (0 = never).
func (m *Manager) LockTimeout() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.timeout
}

// Material is the output of vault creation: what goes to the server and what
// the user must keep.
type Material struct {
	Envelopes   []transport.KeyEnvelope
	RecoveryKey string // shown once, Base32 with checksum
	vmk         vaultcrypto.VMK
}

// ValidatePassphrase enforces the minimum length (strength is estimated in the UI).
func ValidatePassphrase(p string) error {
	if len([]rune(p)) < MinPassphraseLength {
		return ErrShortPassphrase
	}
	return nil
}

func kdfToTransport(k vaultcrypto.KDFParams) transport.KDF {
	return transport.KDF{Alg: k.Alg, T: k.T, MKiB: k.MKiB, P: k.P, Salt: k.Salt}
}

func kdfFromTransport(k transport.KDF) vaultcrypto.KDFParams {
	return vaultcrypto.KDFParams{Alg: k.Alg, T: k.T, MKiB: k.MKiB, P: k.P, Salt: k.Salt}
}

// NewMaterial generates the VMK and recovery key of a new private vault and
// wraps the VMK under both (§3.8.4 flow 1). Nothing is stored yet.
func (m *Manager) NewMaterial(passphrase string) (Material, error) {
	if err := ValidatePassphrase(passphrase); err != nil {
		return Material{}, err
	}
	vmk, err := vaultcrypto.GenerateVMK()
	if err != nil {
		return Material{}, err
	}
	rk, err := vaultcrypto.GenerateRecoveryKey()
	if err != nil {
		return Material{}, err
	}
	pass, err := m.passphraseEnvelope(vmk, passphrase)
	if err != nil {
		return Material{}, err
	}
	rec, err := recoveryEnvelope(vmk, rk)
	if err != nil {
		return Material{}, err
	}
	return Material{Envelopes: []transport.KeyEnvelope{pass, rec}, RecoveryKey: rk.String(), vmk: vmk}, nil
}

func (m *Manager) passphraseEnvelope(vmk vaultcrypto.VMK, passphrase string) (transport.KeyEnvelope, error) {
	kdf := vaultcrypto.CalibratePassphraseKDF(m.kdfTarget)
	kek, err := vaultcrypto.DeriveKEKPassphrase(passphrase, kdf)
	if err != nil {
		return transport.KeyEnvelope{}, err
	}
	w, err := vaultcrypto.Wrap(kek, vmk)
	if err != nil {
		return transport.KeyEnvelope{}, err
	}
	return transport.KeyEnvelope{Kind: KindPassphrase, KDF: kdfToTransport(kdf), WrappedVMK: w}, nil
}

func recoveryEnvelope(vmk vaultcrypto.VMK, rk vaultcrypto.RecoveryKey) (transport.KeyEnvelope, error) {
	kdf := vaultcrypto.NewRecoveryKDF()
	kek, err := vaultcrypto.DeriveKEKRecovery(rk, kdf)
	if err != nil {
		return transport.KeyEnvelope{}, err
	}
	w, err := vaultcrypto.Wrap(kek, vmk)
	if err != nil {
		return transport.KeyEnvelope{}, err
	}
	return transport.KeyEnvelope{Kind: KindRecovery, KDF: kdfToTransport(kdf), WrappedVMK: w}, nil
}

// Adopt makes a newly created vault usable on this device: it is unlocked
// and (unless disabled) its VMK goes to the keychain.
func (m *Manager) Adopt(cloudVaultID string, mat Material) error {
	return m.activate(cloudVaultID, mat.vmk)
}

func (m *Manager) activate(cloudVaultID string, vmk vaultcrypto.VMK) error {
	vid, err := vaultcrypto.ParseUUID(cloudVaultID)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.vaults[cloudVaultID] = &unlocked{sub: vaultcrypto.DeriveSubkeys(vmk), vmk: vmk, vaultID: vid, used: m.now()}
	remember := m.remember
	m.mu.Unlock()
	if remember {
		return m.store.Set(account(cloudVaultID), base64.StdEncoding.EncodeToString(vmk[:]))
	}
	return nil
}

func account(cloudVaultID string) string { return "vmk:" + cloudVaultID }

// Restore unlocks a vault from the keychain (done at startup, no prompt).
// It reports whether the vault is now unlocked.
func (m *Manager) Restore(cloudVaultID string) (bool, error) {
	if !m.IsLocked(cloudVaultID) {
		return true, nil
	}
	v, err := m.store.Get(account(cloudVaultID))
	if err != nil || v == "" {
		return false, err
	}
	raw, err := base64.StdEncoding.DecodeString(v)
	if err != nil || len(raw) != vaultcrypto.KeySize {
		_ = m.store.Delete(account(cloudVaultID))
		return false, nil
	}
	var vmk vaultcrypto.VMK
	copy(vmk[:], raw)
	return true, m.activate(cloudVaultID, vmk)
}

func find(envs []transport.KeyEnvelope, kind string) (transport.KeyEnvelope, bool) {
	for _, e := range envs {
		if e.Kind == kind {
			return e, true
		}
	}
	return transport.KeyEnvelope{}, false
}

// Unlock opens the vault with the passphrase or the recovery key. When the
// recovery key was used the caller must make the user choose a new passphrase
// (requiresNewPassphrase, §3.8.4 flow 4).
func (m *Manager) Unlock(cloudVaultID string, envs []transport.KeyEnvelope, secret string, recovery bool) (requiresNewPassphrase bool, err error) {
	var vmk vaultcrypto.VMK
	if recovery {
		env, ok := find(envs, KindRecovery)
		if !ok {
			return false, ErrNoEnvelope
		}
		rk, perr := vaultcrypto.ParseRecoveryKey(secret)
		if perr != nil {
			return false, perr
		}
		kek, derr := vaultcrypto.DeriveKEKRecovery(rk, kdfFromTransport(env.KDF))
		if derr != nil {
			return false, derr
		}
		if vmk, err = vaultcrypto.Unwrap(kek, env.WrappedVMK); err != nil {
			return false, ErrWrongSecret
		}
		requiresNewPassphrase = true
	} else {
		env, ok := find(envs, KindPassphrase)
		if !ok {
			return false, ErrNoEnvelope
		}
		kek, derr := vaultcrypto.DeriveKEKPassphrase(secret, kdfFromTransport(env.KDF))
		if derr != nil {
			return false, derr
		}
		if vmk, err = vaultcrypto.Unwrap(kek, env.WrappedVMK); err != nil {
			return false, ErrWrongSecret
		}
	}
	return requiresNewPassphrase, m.activate(cloudVaultID, vmk)
}

// NewPassphraseEnvelope re-wraps the unlocked VMK under a new passphrase
// (§3.8.4 flow 3): no data is re-encrypted.
func (m *Manager) NewPassphraseEnvelope(cloudVaultID, newPassphrase string) (transport.KeyEnvelope, error) {
	if err := ValidatePassphrase(newPassphrase); err != nil {
		return transport.KeyEnvelope{}, err
	}
	u, err := m.get(cloudVaultID)
	if err != nil {
		return transport.KeyEnvelope{}, err
	}
	return m.passphraseEnvelope(u.vmk, newPassphrase)
}

// NewRecoveryEnvelope generates a fresh recovery key for the unlocked VMK; the
// returned text must be shown to the user (the old key stops working once the
// envelope is replaced on the server).
func (m *Manager) NewRecoveryEnvelope(cloudVaultID string) (transport.KeyEnvelope, string, error) {
	u, err := m.get(cloudVaultID)
	if err != nil {
		return transport.KeyEnvelope{}, "", err
	}
	rk, err := vaultcrypto.GenerateRecoveryKey()
	if err != nil {
		return transport.KeyEnvelope{}, "", err
	}
	env, err := recoveryEnvelope(u.vmk, rk)
	return env, rk.String(), err
}

// VerifyPassphrase checks a passphrase against the stored envelope without
// changing any state (used before sensitive operations).
func (m *Manager) VerifyPassphrase(envs []transport.KeyEnvelope, passphrase string) error {
	env, ok := find(envs, KindPassphrase)
	if !ok {
		return ErrNoEnvelope
	}
	kek, err := vaultcrypto.DeriveKEKPassphrase(passphrase, kdfFromTransport(env.KDF))
	if err != nil {
		return err
	}
	if _, err := vaultcrypto.Unwrap(kek, env.WrappedVMK); err != nil {
		return ErrWrongSecret
	}
	return nil
}

// Lock forgets the VMK in memory and in the keychain: the passphrase or the
// recovery key is needed again.
func (m *Manager) Lock(cloudVaultID string) error {
	m.mu.Lock()
	delete(m.vaults, cloudVaultID)
	m.mu.Unlock()
	return m.store.Delete(account(cloudVaultID))
}

// Forget removes every trace of a vault (when it is unlinked).
func (m *Manager) Forget(cloudVaultID string) error { return m.Lock(cloudVaultID) }

// IsLocked reports whether the VMK is unavailable (including idle timeout).
func (m *Manager) IsLocked(cloudVaultID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.vaults[cloudVaultID]
	if !ok {
		return true
	}
	if m.idleLocked(u) {
		delete(m.vaults, cloudVaultID)
		go func() { _ = m.store.Delete(account(cloudVaultID)) }()
		return true
	}
	return false
}

// idleLocked reports whether u has been idle past the timeout (m.mu held).
func (m *Manager) idleLocked(u *unlocked) bool {
	return m.timeout > 0 && m.now().Sub(u.used) > m.timeout
}

// LockIdle locks every vault idle past the timeout, in memory and in the
// keychain, and returns their cloud ids. IsLocked does the same lazily; this
// is called periodically so the key leaves memory even when nothing asks.
func (m *Manager) LockIdle() []string {
	m.mu.Lock()
	var ids []string
	for id, u := range m.vaults {
		if m.idleLocked(u) {
			delete(m.vaults, id)
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.store.Delete(account(id))
	}
	return ids
}

func (m *Manager) get(cloudVaultID string) (*unlocked, error) {
	if m.IsLocked(cloudVaultID) {
		return nil, ErrLocked
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.vaults[cloudVaultID]
	if u == nil {
		return nil, ErrLocked
	}
	u.used = m.now()
	return u, nil
}

// Cipher returns the sync engine's view of a private vault.
func (m *Manager) Cipher(cloudVaultID string) *Cipher { return &Cipher{m: m, id: cloudVaultID} }

// Cipher implements sync.Cipher for one vault.
type Cipher struct {
	m  *Manager
	id string
}

// Locked implements sync.Cipher.
func (c *Cipher) Locked() bool { return c.m.IsLocked(c.id) }

// EncryptPath implements sync.Cipher.
func (c *Cipher) EncryptPath(path string) (string, string, error) {
	u, err := c.m.get(c.id)
	if err != nil {
		return "", "", err
	}
	tok, err := vaultcrypto.EncryptPath(u.sub, u.vaultID, path)
	if err != nil {
		return "", "", err
	}
	key, err := vaultcrypto.PathKey(u.sub, path)
	return tok, key, err
}

// DecryptPath implements sync.Cipher.
func (c *Cipher) DecryptPath(token string) (string, error) {
	u, err := c.m.get(c.id)
	if err != nil {
		return "", err
	}
	return vaultcrypto.DecryptPath(u.sub, u.vaultID, token)
}

// EncryptBlob implements sync.Cipher.
func (c *Cipher) EncryptBlob(fileID string, plaintext []byte) ([]byte, error) {
	u, err := c.m.get(c.id)
	if err != nil {
		return nil, err
	}
	fid, err := vaultcrypto.ParseUUID(fileID)
	if err != nil {
		return nil, err
	}
	return vaultcrypto.Encrypt(u.sub, u.vaultID, fid, plaintext)
}

// DecryptBlob implements sync.Cipher.
func (c *Cipher) DecryptBlob(fileID string, blob []byte) ([]byte, error) {
	u, err := c.m.get(c.id)
	if err != nil {
		return nil, err
	}
	fid, err := vaultcrypto.ParseUUID(fileID)
	if err != nil {
		return nil, err
	}
	return vaultcrypto.Decrypt(u.sub, u.vaultID, fid, blob)
}
