// Package crypto is the desktop side of end-to-end encryption (§2.5 "crypto",
// §3.8): it creates the key material of private vaults, unlocks them with the
// passphrase or the recovery key, keeps the VMK in memory (and in the OS
// keychain) and exposes it to the sync engine as a Cipher. The primitives and
// formats live in shared/go/vaultcrypto.
package crypto

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/apiclient"
	flags "memobrain/shared/features"
	"memobrain/shared/vaultcrypto"
)

// Errors.
var (
	ErrWrongSecret = errors.New("wrong passphrase or recovery key")
	ErrNoEnvelope  = errors.New("the vault has no matching key envelope")
	ErrLocked      = errors.New("vault is locked")
	// ErrEnvelopeDowngrade means the server served a v1 envelope of a kind
	// this device has already seen in format v2 for the vault (ADR-0034
	// pinning): it may be the envelope of another vault.
	ErrEnvelopeDowngrade = errors.New("the key envelope is in an older format than this device has already seen for this vault")
)

// Envelope kinds.
const (
	KindPassphrase = "passphrase"
	KindRecovery   = "recovery"
)

// unlocked is the key material of one unlocked vault: a single *Subkeys,
// which holds the only long-lived copy of the VMK, wiped when the vault is
// locked (best effort, see vaultcrypto's key hygiene notes).
type unlocked struct {
	// kmu guards sub: crypto operations hold it for reading and wipe for
	// writing, so a lock never zeroes the keys under a running operation, and
	// an operation that starts after the wipe gets ErrLocked instead of
	// working with zeroed keys.
	kmu     sync.RWMutex
	sub     *vaultcrypto.Subkeys
	vaultID [16]byte
	used    time.Time
}

// use runs fn with the subkeys; a wiped vault is ErrLocked.
func (u *unlocked) use(fn func(s *vaultcrypto.Subkeys) error) error {
	u.kmu.RLock()
	defer u.kmu.RUnlock()
	if u.sub.Wiped() {
		return ErrLocked
	}
	return fn(u.sub)
}

// vmk returns a copy of the VMK (to re-wrap it); the caller wipes it.
func (u *unlocked) vmk() (vaultcrypto.VMK, error) {
	var out vaultcrypto.VMK
	err := u.use(func(s *vaultcrypto.Subkeys) error {
		var err error
		out, err = s.VMK()
		return err
	})
	return out, err
}

// sameVMK reports, in constant time, whether u holds vmk.
func (u *unlocked) sameVMK(vmk *vaultcrypto.VMK) bool {
	cur, err := u.vmk()
	defer cur.Wipe()
	return err == nil && subtle.ConstantTimeCompare(cur[:], vmk[:]) == 1
}

// wipe zeroes the key material once no operation is using it. Safe on nil.
func (u *unlocked) wipe() {
	if u == nil {
		return
	}
	u.kmu.Lock()
	u.sub.Wipe()
	u.kmu.Unlock()
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
	// envelopeV2 writes ADR-0034 v2 envelopes (features.envelope_v2, on by
	// default); off, new envelopes stay v1 unless the vault already has a v2
	// of that kind.
	envelopeV2 bool
	// seenV2 records, per cloud vault id, the envelope kinds known to be v2
	// on the server (seen in a download or pinned by the sync manager), so a
	// re-wrap never downgrades them to v1.
	seenV2 map[string]map[string]bool
	// pathV2 writes ADR-0042 enc2 path tokens (features.path_v2); the sync
	// engine also writes them for a vault pinned to enc2.
	pathV2 bool
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
	// EnvelopeV2 sets the writing of key envelopes in format v2 (ADR-0034);
	// nil takes the Config Profile default of features.envelope_v2 (on since
	// release N+1). The application applies the effective profile on top.
	EnvelopeV2 *bool
	// PathV2 sets the writing of path tokens in format enc2 (ADR-0042); nil
	// takes the default of features.path_v2 (on since release N+1).
	PathV2 *bool
}

// flagOr returns *v when set, the schema default of the Config Profile flag otherwise.
func flagOr(v *bool, flag string) bool {
	if v != nil {
		return *v
	}
	return flags.Defaults[flag]
}

// NewManager creates a manager.
func NewManager(o Options) *Manager {
	if o.Store == nil {
		o.Store = defaultStore()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.KDFTarget == 0 {
		o.KDFTarget = 500 * time.Millisecond
	}
	return &Manager{store: o.Store, now: o.Now, vaults: map[string]*unlocked{}, timeout: o.LockTimeout, remember: !o.DontRemember, kdfTarget: o.KDFTarget, envelopeV2: flagOr(o.EnvelopeV2, flags.EnvelopeV2), seenV2: map[string]map[string]bool{}, pathV2: flagOr(o.PathV2, flags.PathV2)}
}

// SetPathV2 switches the writing of enc2 path tokens (ADR-0042; the Config
// Profile flag features.path_v2).
func (m *Manager) SetPathV2(on bool) {
	m.mu.Lock()
	m.pathV2 = on
	m.mu.Unlock()
}

// PathV2 reports whether new path tokens are written in format enc2.
func (m *Manager) PathV2() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pathV2
}

// SetEnvelopeV2 switches the writing of v2 key envelopes (ADR-0034; the
// Config Profile flag features.envelope_v2).
func (m *Manager) SetEnvelopeV2(on bool) {
	m.mu.Lock()
	m.envelopeV2 = on
	m.mu.Unlock()
}

// EnvelopeV2 reports whether new envelopes are written in format v2.
func (m *Manager) EnvelopeV2() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.envelopeV2
}

// MarkEnvelopeV2 records that the vault's envelope of this kind is v2 on the
// server (the sync manager's pin): later re-wraps of that kind stay v2.
func (m *Manager) MarkEnvelopeV2(cloudVaultID, kind string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.seenV2[cloudVaultID] == nil {
		m.seenV2[cloudVaultID] = map[string]bool{}
	}
	m.seenV2[cloudVaultID][kind] = true
}

// noteEnvelopes records the kinds a download shows in format v2.
func (m *Manager) noteEnvelopes(cloudVaultID string, envs []transport.KeyEnvelope) {
	for _, e := range envs {
		if vaultcrypto.EnvelopeVersion(e.WrappedVmk) == 2 {
			m.MarkEnvelopeV2(cloudVaultID, string(e.Kind))
		}
	}
}

// writeV2 decides the format of a new envelope of kind: v2 when the flag is
// on, or when the vault already has a v2 envelope of that kind (never
// downgrade); v1 otherwise, which every client can read.
func (m *Manager) writeV2(cloudVaultID, kind string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.envelopeV2 || m.seenV2[cloudVaultID][kind]
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
	// keks keeps the key-encryption key of each envelope (by kind) so
	// UpgradeMaterial can re-wrap in format v2 once the vault has an id.
	keks map[string][vaultcrypto.KeySize]byte
}

// Wipe zeroes the VMK and key-encryption keys the material holds. The caller
// calls it once the vault is created and adopted (and upgraded): the material
// is unusable afterwards. Copies of the Material value share keks but not vmk,
// so Wipe the copy that was used last.
func (mat *Material) Wipe() {
	mat.vmk.Wipe()
	for k, kek := range mat.keks {
		vaultcrypto.WipeKey(&kek)
		mat.keks[k] = kek
	}
}

func kdfToTransport(k vaultcrypto.KDFParams) transport.KDF {
	out := transport.KDF{Alg: apiclient.KdfParamsAlg(k.Alg), Salt: k.Salt}
	if k.T != 0 {
		out.T = new(int(k.T))
	}
	if k.MKiB != 0 {
		out.MKib = new(int(k.MKiB))
	}
	if k.P != 0 {
		out.P = new(int(k.P))
	}
	return out
}

func kdfFromTransport(k transport.KDF) vaultcrypto.KDFParams {
	return vaultcrypto.KDFParams{Alg: string(k.Alg), T: uintParam[uint32](k.T), MKiB: uintParam[uint32](k.MKib), P: uintParam[uint8](k.P), Salt: k.Salt}
}

// uintParam converts an optional KDF parameter of the wire format; a value out
// of range becomes 0, which the derivation rejects as invalid parameters.
func uintParam[T uint8 | uint32](p *int) T {
	if p == nil || *p < 0 || uint64(*p) > uint64(^T(0)) {
		return 0
	}
	return T(*p)
}

// NewMaterial generates the VMK and recovery key of a new private vault and
// wraps the VMK under both (§3.8.4 flow 1). Nothing is stored yet. The
// envelopes are v1: the server assigns the vault id only when it creates the
// vault, and v2 binds the envelope to it (see UpgradeMaterial).
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
	pass, passKEK, err := m.passphraseEnvelope(vmk, passphrase, nil)
	if err != nil {
		return Material{}, err
	}
	rec, recKEK, err := recoveryEnvelope(vmk, rk, nil)
	if err != nil {
		return Material{}, err
	}
	keks := map[string][vaultcrypto.KeySize]byte{KindPassphrase: passKEK, KindRecovery: recKEK}
	return Material{Envelopes: []transport.KeyEnvelope{pass, rec}, RecoveryKey: rk.String(), vmk: vmk, keks: keks}, nil
}

// UpgradeMaterial re-wraps the envelopes of a vault just created from mat in
// format v2, bound to the id the server assigned (ADR-0034: v2 is written at
// creation when the flag is on). The KDF parameters stay the same; the caller
// uploads the result in place of the v1 envelopes.
func (m *Manager) UpgradeMaterial(cloudVaultID string, mat Material) ([]transport.KeyEnvelope, error) {
	vid, err := vaultcrypto.ParseUUID(cloudVaultID)
	if err != nil {
		return nil, err
	}
	out := make([]transport.KeyEnvelope, 0, len(mat.Envelopes))
	for _, e := range mat.Envelopes {
		kek, ok := mat.keks[string(e.Kind)]
		if !ok {
			return nil, ErrNoEnvelope
		}
		w, err := wrapChecked(kek, mat.vmk, &vid, string(e.Kind))
		if err != nil {
			return nil, err
		}
		e.WrappedVmk = w
		out = append(out, e)
	}
	return out, nil
}

// wrapChecked wraps the VMK, in format v2 when vaultID is set (v1 otherwise),
// and unwraps the result once before it can replace anything on the server.
func wrapChecked(kek [vaultcrypto.KeySize]byte, vmk vaultcrypto.VMK, vaultID *[16]byte, kind string) ([]byte, error) {
	var w []byte
	var err error
	var vid [16]byte
	if vaultID != nil {
		vid = *vaultID
		w, err = vaultcrypto.WrapV2(kek, vmk, vid, vaultcrypto.EnvelopeKind(kind))
	} else {
		w, err = vaultcrypto.Wrap(kek, vmk)
	}
	if err != nil {
		return nil, err
	}
	if got, err := vaultcrypto.Unwrap(kek, w, vid, vaultcrypto.EnvelopeKind(kind)); err != nil || got != vmk {
		return nil, errors.New("crypto: the new key envelope does not open")
	}
	return w, nil
}

// passphraseEnvelope wraps the VMK under the NFC form of the passphrase
// (DeriveKEKPassphrase normalizes), in format v2 when vaultID is set.
func (m *Manager) passphraseEnvelope(vmk vaultcrypto.VMK, passphrase string, vaultID *[16]byte) (transport.KeyEnvelope, [vaultcrypto.KeySize]byte, error) {
	kdf := vaultcrypto.CalibratePassphraseKDF(m.kdfTarget)
	kek, err := vaultcrypto.DeriveKEKPassphrase(passphrase, kdf)
	if err != nil {
		return transport.KeyEnvelope{}, kek, err
	}
	w, err := wrapChecked(kek, vmk, vaultID, KindPassphrase)
	if err != nil {
		return transport.KeyEnvelope{}, kek, err
	}
	return transport.KeyEnvelope{Kind: KindPassphrase, Kdf: kdfToTransport(kdf), WrappedVmk: w}, kek, nil
}

func recoveryEnvelope(vmk vaultcrypto.VMK, rk vaultcrypto.RecoveryKey, vaultID *[16]byte) (transport.KeyEnvelope, [vaultcrypto.KeySize]byte, error) {
	kdf := vaultcrypto.NewRecoveryKDF()
	kek, err := vaultcrypto.DeriveKEKRecovery(rk, kdf)
	if err != nil {
		return transport.KeyEnvelope{}, kek, err
	}
	w, err := wrapChecked(kek, vmk, vaultID, KindRecovery)
	if err != nil {
		return transport.KeyEnvelope{}, kek, err
	}
	return transport.KeyEnvelope{Kind: KindRecovery, Kdf: kdfToTransport(kdf), WrappedVmk: w}, kek, nil
}

// v2Target returns the vault id to bind a new envelope of kind to, or nil to
// write v1 (see writeV2).
func (m *Manager) v2Target(u *unlocked, cloudVaultID, kind string) *[16]byte {
	if !m.writeV2(cloudVaultID, kind) {
		return nil
	}
	vid := u.vaultID
	return &vid
}

// Adopt makes a newly created vault usable on this device: it is unlocked
// and (unless disabled) its VMK goes to the keychain.
func (m *Manager) Adopt(cloudVaultID string, mat Material) error {
	return m.activate(cloudVaultID, mat.vmk)
}

// activate makes vmk the key of the vault. Unlocking a vault already
// unlocked with the same VMK only restarts its idle timer, so operations in
// flight keep their keys; a different VMK replaces the old key material,
// which is wiped.
func (m *Manager) activate(cloudVaultID string, vmk vaultcrypto.VMK) error {
	vid, err := vaultcrypto.ParseUUID(cloudVaultID)
	if err != nil {
		return err
	}
	m.mu.Lock()
	cur := m.vaults[cloudVaultID]
	m.mu.Unlock()
	// sameVMK takes cur.kmu, which is never taken under m.mu.
	same := cur != nil && cur.sameVMK(&vmk)
	var old *unlocked
	m.mu.Lock()
	if same && m.vaults[cloudVaultID] == cur {
		cur.used = m.now()
	} else {
		old = m.vaults[cloudVaultID]
		m.vaults[cloudVaultID] = &unlocked{sub: vaultcrypto.DeriveSubkeys(vmk), vaultID: vid, used: m.now()}
	}
	remember := m.remember
	m.mu.Unlock()
	old.wipe()
	if remember {
		return m.store.Set(account(cloudVaultID), base64.StdEncoding.EncodeToString(vmk[:]))
	}
	return nil
}

func account(cloudVaultID string) string { return "vmk:" + cloudVaultID }

// Restore unlocks a vault from the keychain (done at startup, no prompt).
// It reports whether the vault is now unlocked.
func (m *Manager) Restore(cloudVaultID string) (bool, error) {
	m.mu.Lock()
	u, present := m.vaults[cloudVaultID]
	expired := present && m.idleLocked(u)
	m.mu.Unlock()
	if present {
		// An expired vault is about to be locked: the keychain copy must not
		// open it again behind the user's back.
		return !expired, nil
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
	clear(raw)
	defer vmk.Wipe()
	return true, m.activate(cloudVaultID, vmk)
}

func find(envs []transport.KeyEnvelope, kind string) (transport.KeyEnvelope, bool) {
	for _, e := range envs {
		if string(e.Kind) == kind {
			return e, true
		}
	}
	return transport.KeyEnvelope{}, false
}

// Unlock opens the vault with the passphrase or the recovery key. When the
// recovery key was used the caller must make the user choose a new passphrase
// (requiresNewPassphrase, §3.8.4 flow 4). See UnlockWith.
func (m *Manager) Unlock(cloudVaultID string, envs []transport.KeyEnvelope, secret string, recovery bool) (requiresNewPassphrase bool, err error) {
	res, err := m.UnlockWith(cloudVaultID, envs, secret, recovery, UnlockOptions{})
	return res.RequiresNewPassphrase, err
}

// UnlockOptions refine UnlockWith.
type UnlockOptions struct {
	// PinnedV2 lists the envelope kinds this device has already opened (or
	// written) in format v2 for the vault: a v1 envelope of those kinds is
	// refused with ErrEnvelopeDowngrade (ADR-0034 pinning).
	PinnedV2 map[string]bool
}

// UnlockResult describes a successful unlock.
type UnlockResult struct {
	// RequiresNewPassphrase is set after an unlock with the recovery key.
	RequiresNewPassphrase bool
	// Kind is the envelope that opened (passphrase or recovery).
	Kind string
	// Version is its format (1 or 2).
	Version int
	// Legacy reports a passphrase envelope that opened only with the raw,
	// non-NFC form of the input (written before normalization).
	Legacy bool
	// Upgrade, when set, re-wraps the same VMK under the same KDF parameters
	// in format v2 (and, for a passphrase, under the NFC form): the caller
	// uploads it in place of the envelope of the same kind. It is only set
	// while v2 writing is on (release N+1 behavior), because a client that
	// predates release N could no longer open the replaced envelope.
	Upgrade *transport.KeyEnvelope
}

// UnlockWith opens the vault with the passphrase or the recovery key. Both
// envelope formats are accepted; a v2 envelope opens only for this vault and
// kind. A passphrase is tried in NFC form first, then in the forms the
// envelopes written before normalization may use (vaultcrypto.PassphraseForms).
func (m *Manager) UnlockWith(cloudVaultID string, envs []transport.KeyEnvelope, secret string, recovery bool, o UnlockOptions) (UnlockResult, error) {
	res := UnlockResult{Kind: KindPassphrase, RequiresNewPassphrase: recovery}
	if recovery {
		res.Kind = KindRecovery
	}
	env, ok := find(envs, res.Kind)
	if !ok {
		return UnlockResult{}, ErrNoEnvelope
	}
	vid, err := vaultcrypto.ParseUUID(cloudVaultID)
	if err != nil {
		return UnlockResult{}, err
	}
	m.noteEnvelopes(cloudVaultID, envs)
	for kind, pinned := range o.PinnedV2 {
		if pinned {
			m.MarkEnvelopeV2(cloudVaultID, kind)
		}
	}
	res.Version = vaultcrypto.EnvelopeVersion(env.WrappedVmk)
	if res.Version == 1 && o.PinnedV2[res.Kind] {
		return UnlockResult{}, ErrEnvelopeDowngrade
	}
	var vmk vaultcrypto.VMK
	var kek [vaultcrypto.KeySize]byte
	defer vmk.Wipe()
	defer vaultcrypto.WipeKey(&kek)
	if recovery {
		rk, perr := vaultcrypto.ParseRecoveryKey(secret)
		if perr != nil {
			return UnlockResult{}, perr
		}
		if kek, err = vaultcrypto.DeriveKEKRecovery(rk, kdfFromTransport(env.Kdf)); err != nil {
			return UnlockResult{}, err
		}
		if vmk, err = vaultcrypto.Unwrap(kek, env.WrappedVmk, vid, vaultcrypto.KindRecovery); err != nil {
			return UnlockResult{}, ErrWrongSecret
		}
	} else {
		open, oerr := vaultcrypto.OpenWithPassphrase(secret, kdfFromTransport(env.Kdf), env.WrappedVmk, vid)
		if errors.Is(oerr, vaultcrypto.ErrDecrypt) {
			return UnlockResult{}, ErrWrongSecret
		}
		if oerr != nil {
			return UnlockResult{}, oerr
		}
		vmk, kek, res.Legacy = open.VMK, open.KEK, open.Legacy
		open.VMK.Wipe()
		vaultcrypto.WipeKey(&open.KEK)
	}
	if m.EnvelopeV2() && (res.Version == 1 || res.Legacy) {
		if w, werr := wrapChecked(kek, vmk, &vid, res.Kind); werr == nil {
			up := env
			up.WrappedVmk = w
			res.Upgrade = &up
		}
	}
	return res, m.activate(cloudVaultID, vmk)
}

// NewPassphraseEnvelope re-wraps the unlocked VMK under a new passphrase
// (§3.8.4 flow 3): no data is re-encrypted. The passphrase is normalized to
// NFC; the envelope is v2 when writeV2 says so.
func (m *Manager) NewPassphraseEnvelope(cloudVaultID, newPassphrase string) (transport.KeyEnvelope, error) {
	if err := ValidatePassphrase(newPassphrase); err != nil {
		return transport.KeyEnvelope{}, err
	}
	u, err := m.get(cloudVaultID)
	if err != nil {
		return transport.KeyEnvelope{}, err
	}
	vmk, err := u.vmk()
	if err != nil {
		return transport.KeyEnvelope{}, err
	}
	defer vmk.Wipe()
	env, kek, err := m.passphraseEnvelope(vmk, newPassphrase, m.v2Target(u, cloudVaultID, KindPassphrase))
	vaultcrypto.WipeKey(&kek)
	return env, err
}

// NewRecoveryEnvelope generates a fresh recovery key for the unlocked VMK; the
// returned text must be shown to the user (the old key stops working once the
// envelope is replaced on the server).
func (m *Manager) NewRecoveryEnvelope(cloudVaultID string) (transport.KeyEnvelope, string, error) {
	u, err := m.get(cloudVaultID)
	if err != nil {
		return transport.KeyEnvelope{}, "", err
	}
	vmk, err := u.vmk()
	if err != nil {
		return transport.KeyEnvelope{}, "", err
	}
	defer vmk.Wipe()
	rk, err := vaultcrypto.GenerateRecoveryKey()
	if err != nil {
		return transport.KeyEnvelope{}, "", err
	}
	defer clear(rk[:])
	env, kek, err := recoveryEnvelope(vmk, rk, m.v2Target(u, cloudVaultID, KindRecovery))
	vaultcrypto.WipeKey(&kek)
	return env, rk.String(), err
}

// VerifyPassphrase checks a passphrase against the vault's stored envelope
// without changing any state (used before sensitive operations).
func (m *Manager) VerifyPassphrase(cloudVaultID string, envs []transport.KeyEnvelope, passphrase string) error {
	env, ok := find(envs, KindPassphrase)
	if !ok {
		return ErrNoEnvelope
	}
	vid, err := vaultcrypto.ParseUUID(cloudVaultID)
	if err != nil {
		return err
	}
	m.noteEnvelopes(cloudVaultID, envs)
	open, err := vaultcrypto.OpenWithPassphrase(passphrase, kdfFromTransport(env.Kdf), env.WrappedVmk, vid)
	open.VMK.Wipe()
	vaultcrypto.WipeKey(&open.KEK)
	if errors.Is(err, vaultcrypto.ErrDecrypt) {
		return ErrWrongSecret
	}
	return err
}

// Lock forgets the VMK in memory and in the keychain: the passphrase or the
// recovery key is needed again.
func (m *Manager) Lock(cloudVaultID string) error {
	m.mu.Lock()
	u := m.vaults[cloudVaultID]
	delete(m.vaults, cloudVaultID)
	m.mu.Unlock()
	u.wipe()
	return m.store.Delete(account(cloudVaultID))
}

// Forget removes every trace of a vault (when it is unlinked).
func (m *Manager) Forget(cloudVaultID string) error {
	m.mu.Lock()
	delete(m.seenV2, cloudVaultID)
	m.mu.Unlock()
	return m.Lock(cloudVaultID)
}

// The idle timer only counts what the user does. Unlocking starts it and Touch
// (fed by the user interface) restarts it; the sync engine's work through the
// Cipher never does, or a vault edited on another device would never lock.
//
// A vault idle past the timeout is "expired": IsLocked reports it as locked
// and every user-facing operation refuses it, but its key stays in memory
// until the sync manager has pushed what waits for upload (the engine still
// encrypts through the Cipher) and calls LockExpired. Expiry is never undone
// by Touch: only a new unlock opens the vault again.

// Touch records user activity: the idle timer of every unlocked vault that has
// not expired yet starts again.
func (m *Manager) Touch() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	for _, u := range m.vaults {
		if !m.idleLocked(u) {
			u.used = now
		}
	}
}

// IsLocked reports whether the VMK is unavailable to the user: never unlocked,
// locked, or idle past the timeout.
func (m *Manager) IsLocked(cloudVaultID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.vaults[cloudVaultID]
	return !ok || m.idleLocked(u)
}

// idleLocked reports whether u has been idle past the timeout (m.mu held).
func (m *Manager) idleLocked(u *unlocked) bool {
	return m.timeout > 0 && m.now().Sub(u.used) > m.timeout
}

// IdleVaults returns the cloud ids of the vaults idle past the timeout whose
// key is still in memory. Nothing is locked: the caller drains them first and
// then calls LockExpired.
func (m *Manager) IdleVaults() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	for id, u := range m.vaults {
		if m.idleLocked(u) {
			ids = append(ids, id)
		}
	}
	return ids
}

// LockExpired locks the vault, in memory and in the keychain, only if it is
// still idle past the timeout: a vault unlocked again meanwhile stays open. It
// reports whether the key was removed from memory.
func (m *Manager) LockExpired(cloudVaultID string) (bool, error) {
	m.mu.Lock()
	u, ok := m.vaults[cloudVaultID]
	if !ok || !m.idleLocked(u) {
		m.mu.Unlock()
		return false, nil
	}
	delete(m.vaults, cloudVaultID)
	m.mu.Unlock()
	u.wipe()
	return true, m.store.Delete(account(cloudVaultID))
}

// LockIdle locks every vault idle past the timeout at once, without giving
// anything a chance to be pushed, and returns their cloud ids. The sync
// manager drains first (IdleVaults + LockExpired); this is for vaults no sync
// engine holds.
func (m *Manager) LockIdle() []string {
	var ids []string
	for _, id := range m.IdleVaults() {
		if ok, _ := m.LockExpired(id); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// get returns the key of a vault for an operation the user asked for: an
// expired vault is locked, and the use counts as activity.
func (m *Manager) get(cloudVaultID string) (*unlocked, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.vaults[cloudVaultID]
	if u == nil || m.idleLocked(u) {
		return nil, ErrLocked
	}
	u.used = m.now()
	return u, nil
}

// key returns the key of a vault for the sync engine: it works until the key
// leaves memory (an expired vault still drains its uploads) and does not count
// as activity.
func (m *Manager) key(cloudVaultID string) (*unlocked, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.vaults[cloudVaultID]
	if u == nil {
		return nil, ErrLocked
	}
	return u, nil
}

// Cipher returns the sync engine's view of a private vault.
func (m *Manager) Cipher(cloudVaultID string) *Cipher { return &Cipher{m: m, id: cloudVaultID} }

// Cipher implements sync.Cipher for one vault.
type Cipher struct {
	m  *Manager
	id string
}

// Locked implements sync.Cipher: the key has left memory. An expired vault
// is not locked for the engine until the sync manager has drained it.
func (c *Cipher) Locked() bool {
	_, err := c.m.key(c.id)
	return err != nil
}

// PathV2 implements sync.Cipher: the features.path_v2 flag (ADR-0042).
func (c *Cipher) PathV2() bool { return c.m.PathV2() }

// EncryptPath implements sync.Cipher: the token of the file's path, enc2
// (bound to the file) when v2 is set, enc1 otherwise, and its uniqueness key.
func (c *Cipher) EncryptPath(fileID, path string, v2 bool) (string, string, error) {
	u, err := c.m.key(c.id)
	if err != nil {
		return "", "", err
	}
	var tok, key string
	err = u.use(func(s *vaultcrypto.Subkeys) error {
		var err error
		if v2 {
			fid, perr := vaultcrypto.ParseUUID(fileID)
			if perr != nil {
				return perr
			}
			tok, err = vaultcrypto.EncryptPathV2(s, u.vaultID, fid, path)
		} else {
			tok, err = vaultcrypto.EncryptPath(s, u.vaultID, path)
		}
		if err != nil {
			return err
		}
		key, err = vaultcrypto.PathKey(s, path)
		return err
	})
	return tok, key, err
}

// DecryptFilePath implements sync.Cipher: an enc1 or enc2 token of the file.
func (c *Cipher) DecryptFilePath(fileID, token string) (string, error) {
	u, err := c.m.key(c.id)
	if err != nil {
		return "", err
	}
	fid, err := vaultcrypto.ParseUUID(fileID)
	if err != nil {
		return "", err
	}
	var out string
	err = u.use(func(s *vaultcrypto.Subkeys) error {
		var err error
		out, err = vaultcrypto.DecryptPathFor(s, u.vaultID, fid, token)
		return err
	})
	return out, err
}

// DecryptPath implements sync.Cipher: an enc1 token only, for callers that
// do not know the file id (an enc2 token is a format error here).
func (c *Cipher) DecryptPath(token string) (string, error) {
	u, err := c.m.key(c.id)
	if err != nil {
		return "", err
	}
	var out string
	err = u.use(func(s *vaultcrypto.Subkeys) error {
		var err error
		out, err = vaultcrypto.DecryptPath(s, u.vaultID, token)
		return err
	})
	return out, err
}

// EncryptBlob implements sync.Cipher.
func (c *Cipher) EncryptBlob(fileID string, plaintext []byte) ([]byte, error) {
	u, err := c.m.key(c.id)
	if err != nil {
		return nil, err
	}
	fid, err := vaultcrypto.ParseUUID(fileID)
	if err != nil {
		return nil, err
	}
	var out []byte
	err = u.use(func(s *vaultcrypto.Subkeys) error {
		var err error
		out, err = vaultcrypto.Encrypt(s, u.vaultID, fid, plaintext)
		return err
	})
	return out, err
}

// DecryptBlob implements sync.Cipher.
func (c *Cipher) DecryptBlob(fileID string, blob []byte) ([]byte, error) {
	u, err := c.m.key(c.id)
	if err != nil {
		return nil, err
	}
	fid, err := vaultcrypto.ParseUUID(fileID)
	if err != nil {
		return nil, err
	}
	var out []byte
	err = u.use(func(s *vaultcrypto.Subkeys) error {
		var err error
		out, err = vaultcrypto.Decrypt(s, u.vaultID, fid, blob)
		return err
	})
	return out, err
}
