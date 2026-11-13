package crypto

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/vaultcrypto"
)

const vaultID = "0194f0a8-0000-7000-8000-00000000aaaa"

func newManager(t *testing.T) (*Manager, *MemoryStore, *time.Time) {
	t.Helper()
	store := NewMemoryStore()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	m := NewManager(Options{Store: store, Now: func() time.Time { return now }, KDFTarget: time.Millisecond})
	return m, store, &now
}

func TestCreateUnlockAndRoundTrip(t *testing.T) {
	m, _, _ := newManager(t)
	mat, err := m.NewMaterial("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if len(mat.Envelopes) != 2 || mat.RecoveryKey == "" {
		t.Fatalf("material: %+v", mat)
	}
	if err := m.Adopt(vaultID, mat); err != nil {
		t.Fatal(err)
	}
	c := m.Cipher(vaultID)
	if c.Locked() {
		t.Fatal("locked after adopt")
	}
	file := uuid.NewString()
	ct, err := c.EncryptBlob(file, []byte("secret note"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ct, []byte("secret")) {
		t.Fatal("ciphertext leaks the plaintext")
	}
	if pt, err := c.DecryptBlob(file, ct); err != nil || string(pt) != "secret note" {
		t.Fatalf("decrypt: %q %v", pt, err)
	}
	// A blob does not decrypt under another file's identity.
	if _, err := c.DecryptBlob(uuid.NewString(), ct); err == nil {
		t.Fatal("blob decrypted for a different file id")
	}
	tok, key, err := c.EncryptPath(file, "Journal/Day 1.md", false)
	if err != nil || key == "" || !strings.HasPrefix(tok, "enc1:") {
		t.Fatal(err)
	}
	if got, err := c.DecryptPath(tok); err != nil || got != "Journal/Day 1.md" {
		t.Fatalf("path: %q %v", got, err)
	}
	if got, err := c.DecryptFilePath(file, tok); err != nil || got != "Journal/Day 1.md" {
		t.Fatalf("enc1 path through DecryptFilePath: %q %v", got, err)
	}
	_, key2, _ := c.EncryptPath(file, "journal/day 1.md", false)
	if key != key2 {
		t.Error("case variants must share the path key")
	}
	// enc2 (ADR-0042): bound to the file, same uniqueness key.
	tok2, key3, err := c.EncryptPath(file, "Journal/Day 1.md", true)
	if err != nil || key3 != key || !strings.HasPrefix(tok2, "enc2:") {
		t.Fatalf("enc2: %q %q %v", tok2, key3, err)
	}
	if got, err := c.DecryptFilePath(file, tok2); err != nil || got != "Journal/Day 1.md" {
		t.Fatalf("enc2 path: %q %v", got, err)
	}
	if _, err := c.DecryptFilePath(uuid.NewString(), tok2); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Fatalf("enc2 token opened for another file: %v", err)
	}

	// A second device unlocks with the passphrase and reads the same data.
	other, _, _ := newManager(t)
	req, err := other.Unlock(vaultID, mat.Envelopes, "correct horse battery staple", false)
	if err != nil || req {
		t.Fatalf("unlock: %v requiresNew=%v", err, req)
	}
	if pt, err := other.Cipher(vaultID).DecryptBlob(file, ct); err != nil || string(pt) != "secret note" {
		t.Fatalf("second device: %q %v", pt, err)
	}
	if _, err := other.Unlock(vaultID, mat.Envelopes, "a different passphrase!!", false); !errors.Is(err, ErrWrongSecret) {
		t.Fatalf("wrong passphrase: %v", err)
	}
}

func TestRecoveryKeyFlow(t *testing.T) {
	m, _, _ := newManager(t)
	mat, _ := m.NewMaterial("correct horse battery staple")
	other, _, _ := newManager(t)
	req, err := other.Unlock(vaultID, mat.Envelopes, mat.RecoveryKey, true)
	if err != nil || !req {
		t.Fatalf("recovery unlock: %v requiresNew=%v", err, req)
	}
	// After a recovery the user picks a new passphrase: re-wrap, no re-encryption.
	env, err := other.NewPassphraseEnvelope(vaultID, "a brand new passphrase")
	if err != nil {
		t.Fatal(err)
	}
	third, _, _ := newManager(t)
	set := mat.Envelopes
	for i := range set {
		if set[i].Kind == KindPassphrase {
			set[i] = env
		}
	}
	if _, err := third.Unlock(vaultID, set, "a brand new passphrase", false); err != nil {
		t.Fatalf("new passphrase: %v", err)
	}
	if _, err := third.Unlock(vaultID, set, "correct horse battery staple", false); !errors.Is(err, ErrWrongSecret) {
		t.Fatalf("old passphrase still works: %v", err)
	}
	// Regenerating the recovery key invalidates the old one.
	renv, rk, err := other.NewRecoveryEnvelope(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	for i := range set {
		if set[i].Kind == KindRecovery {
			set[i] = renv
		}
	}
	fourth, _, _ := newManager(t)
	if _, err := fourth.Unlock(vaultID, set, mat.RecoveryKey, true); !errors.Is(err, ErrWrongSecret) {
		t.Fatalf("old recovery key still works: %v", err)
	}
	if _, err := fourth.Unlock(vaultID, set, rk, true); err != nil {
		t.Fatalf("new recovery key: %v", err)
	}
	if _, err := fourth.Unlock(vaultID, set, "not a key", true); err == nil {
		t.Fatal("malformed recovery key accepted")
	}
}

func TestNewPassphraseNeedsPolicyAndKey(t *testing.T) {
	m, _, _ := newManager(t)
	if _, err := m.NewMaterial("short"); !errors.Is(err, ErrShortPassphrase) {
		t.Fatalf("short passphrase: %v", err)
	}
	if _, err := m.NewPassphraseEnvelope(vaultID, "a long enough one!"); !errors.Is(err, ErrLocked) {
		t.Fatalf("locked vault: %v", err)
	}
}

func TestKeychainRestoreAndLock(t *testing.T) {
	m, store, _ := newManager(t)
	mat, _ := m.NewMaterial("correct horse battery staple")
	if err := m.Adopt(vaultID, mat); err != nil {
		t.Fatal(err)
	}
	// A restart: a fresh manager on the same keychain unlocks without a prompt.
	again := NewManager(Options{Store: store, KDFTarget: time.Millisecond})
	if !again.IsLocked(vaultID) {
		t.Fatal("a new process starts locked")
	}
	ok, err := again.Restore(vaultID)
	if err != nil || !ok || again.IsLocked(vaultID) {
		t.Fatalf("restore: %v %v", ok, err)
	}
	// Locking wipes memory and keychain.
	if err := again.Lock(vaultID); err != nil {
		t.Fatal(err)
	}
	if ok, _ := NewManager(Options{Store: store}).Restore(vaultID); ok {
		t.Fatal("VMK survived Lock in the keychain")
	}
	if _, err := again.Cipher(vaultID).DecryptPath("enc1:AAAA"); !errors.Is(err, ErrLocked) {
		t.Fatalf("locked vault decrypted: %v", err)
	}
}

// TestLockWipesKeys checks the key hygiene of no-key-zeroization: the subkeys
// of a locked vault are zeroed, an operation holding them finishes first, and
// one that starts later gets ErrLocked rather than working with zero keys.
func TestLockWipesKeys(t *testing.T) {
	m, _, _ := newManager(t)
	mat, _ := m.NewMaterial("correct horse battery staple")
	if err := m.Adopt(vaultID, mat); err != nil {
		t.Fatal(err)
	}
	u, err := m.key(vaultID)
	if err != nil {
		t.Fatal(err)
	}
	// Unlocking again with the same VMK keeps the same key material.
	if err := m.Adopt(vaultID, mat); err != nil {
		t.Fatal(err)
	}
	if again, _ := m.key(vaultID); again != u {
		t.Fatal("re-unlock with the same VMK replaced the key material")
	}
	started, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- u.use(func(s *vaultcrypto.Subkeys) error {
			close(started)
			<-release
			if s.Wiped() {
				return errors.New("wiped under a running operation")
			}
			return nil
		})
	}()
	<-started
	locked := make(chan error, 1)
	go func() { locked <- m.Lock(vaultID) }()
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-locked; err != nil {
		t.Fatal(err)
	}
	if !u.sub.Wiped() || u.sub.PathEnc != [32]byte{} || u.sub.PathKey != [32]byte{} {
		t.Fatal("subkeys not wiped by Lock")
	}
	if err := u.use(func(*vaultcrypto.Subkeys) error { return nil }); !errors.Is(err, ErrLocked) {
		t.Fatalf("use after wipe: %v", err)
	}
	// A different VMK replaces (and wipes) the previous key material.
	if err := m.Adopt(vaultID, mat); err != nil {
		t.Fatal(err)
	}
	first, _ := m.key(vaultID)
	other, _ := m.NewMaterial("another correct horse battery")
	if err := m.Adopt(vaultID, other); err != nil {
		t.Fatal(err)
	}
	if !first.sub.Wiped() {
		t.Fatal("replaced key material not wiped")
	}
	other.Wipe()
	if other.vmk != (vaultcrypto.VMK{}) || other.keks[KindPassphrase] != [32]byte{} {
		t.Fatal("material not wiped")
	}
}

// TestPathV2Flag checks the features.path_v2 switch the sync engine reads.
func TestPathV2Flag(t *testing.T) {
	m, _, _ := newManager(t)
	c := m.Cipher(vaultID)
	if !c.PathV2() || !NewManager(Options{}).PathV2() {
		t.Fatal("enc2 writing must be on by default (release N+1)")
	}
	m.SetPathV2(false)
	if c.PathV2() || NewManager(Options{PathV2: new(false)}).PathV2() {
		t.Fatal("flag off not applied")
	}
	m.SetPathV2(true)
	if !c.PathV2() || !NewManager(Options{PathV2: new(true)}).PathV2() {
		t.Fatal("flag not applied")
	}
}

func TestIdleTimeoutLocks(t *testing.T) {
	m, _, now := newManager(t)
	m.SetLockTimeout(10 * time.Minute)
	mat, _ := m.NewMaterial("correct horse battery staple")
	_ = m.Adopt(vaultID, mat)
	*now = now.Add(9 * time.Minute)
	if m.IsLocked(vaultID) {
		t.Fatal("locked too early")
	}
	// User activity resets the idle timer.
	m.Touch()
	*now = now.Add(9 * time.Minute)
	if m.IsLocked(vaultID) {
		t.Fatal("activity did not postpone the lock")
	}
	*now = now.Add(11 * time.Minute)
	if !m.IsLocked(vaultID) {
		t.Fatal("not locked after the idle timeout")
	}
	// Activity after the expiry does not open the vault again.
	m.Touch()
	if !m.IsLocked(vaultID) {
		t.Fatal("Touch revived an expired vault")
	}
	if _, err := m.NewPassphraseEnvelope(vaultID, "another long passphrase"); !errors.Is(err, ErrLocked) {
		t.Fatalf("user operation on an expired vault: %v", err)
	}
}

// The sync engine works through the Cipher in the background (another device
// keeps editing): that must not count as activity, or the vault never locks.
func TestBackgroundUseDoesNotExtendIdle(t *testing.T) {
	m, store, now := newManager(t)
	m.SetLockTimeout(10 * time.Minute)
	mat, _ := m.NewMaterial("correct horse battery staple")
	_ = m.Adopt(vaultID, mat)
	c := m.Cipher(vaultID)
	file := uuid.NewString()
	for range 4 {
		*now = now.Add(4 * time.Minute)
		ct, err := c.EncryptBlob(file, []byte("x"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.DecryptBlob(file, ct); err != nil {
			t.Fatal(err)
		}
		tok, _, err := c.EncryptPath(file, "a.md", false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.DecryptPath(tok); err != nil {
			t.Fatal(err)
		}
	}
	if !m.IsLocked(vaultID) {
		t.Fatal("background encryption kept the vault unlocked")
	}
	if ids := m.IdleVaults(); len(ids) != 1 || ids[0] != vaultID {
		t.Fatalf("IdleVaults = %v", ids)
	}
	// Expired but not locked yet: the engine can still push what waits for
	// upload, and the keychain copy does not reopen the vault.
	if c.Locked() {
		t.Fatal("the engine lost the key before the drain")
	}
	if _, _, err := c.EncryptPath(file, "b.md", true); err != nil {
		t.Fatalf("drain encryption: %v", err)
	}
	if ok, _ := m.Restore(vaultID); ok {
		t.Fatal("Restore reopened an expired vault")
	}
	if ok, err := m.LockExpired(vaultID); !ok || err != nil {
		t.Fatalf("LockExpired = %v, %v", ok, err)
	}
	if !c.Locked() {
		t.Fatal("key still in memory after LockExpired")
	}
	if v, _ := store.Get(account(vaultID)); v != "" {
		t.Fatal("the VMK stayed in the keychain")
	}
}

// LockExpired leaves alone a vault that was unlocked again during the drain.
func TestLockExpiredSkipsReopenedVault(t *testing.T) {
	m, _, now := newManager(t)
	m.SetLockTimeout(time.Minute)
	mat, _ := m.NewMaterial("correct horse battery staple")
	_ = m.Adopt(vaultID, mat)
	*now = now.Add(2 * time.Minute)
	if len(m.IdleVaults()) != 1 {
		t.Fatal("vault not idle")
	}
	_ = m.Adopt(vaultID, mat) // unlocked again meanwhile
	if ok, err := m.LockExpired(vaultID); ok || err != nil {
		t.Fatalf("LockExpired locked a reopened vault: %v %v", ok, err)
	}
	if m.IsLocked(vaultID) {
		t.Fatal("reopened vault locked")
	}
}

// LockIdle is the periodic sweep: it removes the key from memory and from the
// keychain even when nothing asks whether the vault is locked.
func TestLockIdleSweepsExpiredVaults(t *testing.T) {
	m, store, now := newManager(t)
	mat, _ := m.NewMaterial("correct horse battery staple")
	_ = m.Adopt(vaultID, mat)
	*now = now.Add(24 * time.Hour)
	if ids := m.LockIdle(); len(ids) != 0 {
		t.Fatalf("locked %v with no timeout set", ids)
	}

	m.SetLockTimeout(10 * time.Minute)
	if ids := m.LockIdle(); len(ids) != 1 || ids[0] != vaultID {
		t.Fatalf("LockIdle = %v, want [%s]", ids, vaultID)
	}
	if v, _ := store.Get(account(vaultID)); v != "" {
		t.Fatal("the VMK stayed in the keychain")
	}
	if ok, _ := m.Restore(vaultID); ok || !m.IsLocked(vaultID) {
		t.Fatal("vault still unlocked after the sweep")
	}
	if ids := m.LockIdle(); len(ids) != 0 {
		t.Fatalf("locked again: %v", ids)
	}
}

func TestDiskParsers(t *testing.T) {
	cases := []struct {
		got, want DiskEncryption
	}{
		{parseFileVault("FileVault is On.\n"), DiskEncrypted},
		{parseFileVault("FileVault is Off.\n"), DiskUnencrypted},
		{parseFileVault("???"), DiskUnknown},
		{parseBitLocker("1\r\n"), DiskEncrypted},
		{parseBitLocker("0"), DiskUnencrypted},
		{parseBitLocker(""), DiskUnknown},
		{parseLsblk("disk\npart\ncrypt\nlvm\n"), DiskEncrypted},
		{parseLsblk("disk\npart\n"), DiskUnencrypted},
		{parseLsblk(""), DiskUnknown},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Errorf("case %d: %s, want %s", i, c.got, c.want)
		}
	}
}

func envelopeOf(t *testing.T, envs []transport.KeyEnvelope, kind string) transport.KeyEnvelope {
	t.Helper()
	e, ok := find(envs, kind)
	if !ok {
		t.Fatalf("no %s envelope", kind)
	}
	return e
}

func replaceEnvelope(envs []transport.KeyEnvelope, e transport.KeyEnvelope) []transport.KeyEnvelope {
	out := append([]transport.KeyEnvelope(nil), envs...)
	for i := range out {
		if out[i].Kind == e.Kind {
			out[i] = e
		}
	}
	return out
}

// ADR-0034 release N+1: with the default configuration (features.envelope_v2
// on) an unlock of a v1 envelope, passphrase or recovery, proposes its v2
// re-wrap, and a new passphrase or recovery key is written in v2.
func TestEnvelopeV2OnByDefault(t *testing.T) {
	const pass = "correct horse battery staple"
	m, _, _ := newManager(t)
	if !m.EnvelopeV2() {
		t.Fatal("v2 writing must be on by default (release N+1)")
	}
	mat, err := m.NewMaterial(pass)
	if err != nil {
		t.Fatal(err)
	}
	for _, recovery := range []bool{false, true} {
		secret := pass
		if recovery {
			secret = mat.RecoveryKey
		}
		dev, _, _ := newManager(t)
		res, err := dev.UnlockWith(vaultID, mat.Envelopes, secret, recovery, UnlockOptions{})
		if err != nil || res.Version != 1 || res.Upgrade == nil || vaultcrypto.EnvelopeVersion(res.Upgrade.WrappedVmk) != 2 {
			t.Fatalf("recovery=%t: default unlock must propose a v2 upgrade: %+v %v", recovery, res, err)
		}
		if env, err := dev.NewPassphraseEnvelope(vaultID, "a brand new passphrase"); err != nil || vaultcrypto.EnvelopeVersion(env.WrappedVmk) != 2 {
			t.Fatalf("default change of passphrase must write v2: %v", err)
		}
		if env, _, err := dev.NewRecoveryEnvelope(vaultID); err != nil || vaultcrypto.EnvelopeVersion(env.WrappedVmk) != 2 {
			t.Fatalf("default new recovery key must write v2: %v", err)
		}
	}
}

// ADR-0034 with features.envelope_v2 off (the release N default, still
// available to an administrator): v1 is written, v2 only with the flag; both
// are read, a v2 envelope opens only for its vault, and a pinned kind refuses v1.
func TestEnvelopeV2(t *testing.T) {
	const pass = "correct horse battery staple"
	m, _, _ := newManager(t)
	m.SetEnvelopeV2(false)
	mat, err := m.NewMaterial(pass)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range mat.Envelopes {
		if vaultcrypto.EnvelopeVersion(e.WrappedVmk) != 1 {
			t.Fatalf("%s envelope of a new vault must be v1", e.Kind)
		}
	}
	if err := m.Adopt(vaultID, mat); err != nil {
		t.Fatal(err)
	}
	// Flag off: re-wraps stay v1, unlocks propose no upgrade.
	if env, err := m.NewPassphraseEnvelope(vaultID, "another long passphrase"); err != nil || vaultcrypto.EnvelopeVersion(env.WrappedVmk) != 1 {
		t.Fatalf("flag off must write v1: %v", err)
	}
	other, _, _ := newManager(t)
	other.SetEnvelopeV2(false)
	res, err := other.UnlockWith(vaultID, mat.Envelopes, pass, false, UnlockOptions{})
	if err != nil || res.Upgrade != nil || res.Version != 1 || res.Legacy {
		t.Fatalf("v1 unlock, flag off: %+v %v", res, err)
	}

	// After creation, with the flag on, the envelopes are re-wrapped in v2.
	v2, err := m.UpgradeMaterial(vaultID, mat)
	if err != nil || len(v2) != 2 {
		t.Fatalf("upgrade material: %v", err)
	}
	for _, e := range v2 {
		if vaultcrypto.EnvelopeVersion(e.WrappedVmk) != 2 {
			t.Fatalf("%s: not v2", e.Kind)
		}
	}
	third, _, _ := newManager(t)
	if res, err := third.UnlockWith(vaultID, v2, pass, false, UnlockOptions{}); err != nil || res.Version != 2 {
		t.Fatalf("v2 passphrase unlock: %+v %v", res, err)
	}
	if res, err := third.UnlockWith(vaultID, v2, mat.RecoveryKey, true, UnlockOptions{}); err != nil || res.Version != 2 || !res.RequiresNewPassphrase {
		t.Fatalf("v2 recovery unlock: %+v %v", res, err)
	}
	// Served for another vault of the same user (same passphrase): refused.
	const otherVault = "0194f0a8-0000-7000-8000-00000000bbbb"
	if _, err := third.Unlock(otherVault, v2, pass, false); !errors.Is(err, ErrWrongSecret) {
		t.Fatalf("v2 envelope of another vault: %v", err)
	}
	// The recovery envelope served as the passphrase one: refused (kind in the AAD).
	swapped := envelopeOf(t, v2, KindRecovery)
	swapped.Kind = KindPassphrase
	swapped.Kdf = envelopeOf(t, v2, KindPassphrase).Kdf
	if _, err := third.Unlock(vaultID, replaceEnvelope(v2, swapped), pass, false); !errors.Is(err, ErrWrongSecret) {
		t.Fatalf("swapped kind: %v", err)
	}
	// Pinned kinds refuse v1 (a downgrade), other kinds still accept it.
	pins := UnlockOptions{PinnedV2: map[string]bool{KindPassphrase: true}}
	if _, err := third.UnlockWith(vaultID, mat.Envelopes, pass, false, pins); !errors.Is(err, ErrEnvelopeDowngrade) {
		t.Fatalf("pinned v1: %v", err)
	}
	if _, err := third.UnlockWith(vaultID, mat.Envelopes, mat.RecoveryKey, true, pins); err != nil {
		t.Fatalf("unpinned recovery v1: %v", err)
	}
	// A vault seen with v2 envelopes keeps them v2 even with the flag off.
	if env, err := third.NewPassphraseEnvelope(vaultID, "another long passphrase"); err != nil || vaultcrypto.EnvelopeVersion(env.WrappedVmk) != 2 {
		t.Fatalf("seen v2 must stay v2: %v", err)
	}
	if err := third.VerifyPassphrase(vaultID, v2, pass); err != nil {
		t.Fatalf("verify v2: %v", err)
	}
	if err := third.VerifyPassphrase(otherVault, v2, pass); !errors.Is(err, ErrWrongSecret) {
		t.Fatalf("verify v2 of another vault: %v", err)
	}
}

// With the flag on (release N+1 behavior) an unlock of a v1 envelope proposes
// the same VMK re-wrapped in v2 under the same KDF parameters.
func TestUnlockUpgradesToV2WhenEnabled(t *testing.T) {
	const pass = "correct horse battery staple"
	m, _, _ := newManager(t)
	mat, _ := m.NewMaterial(pass)
	dev := NewManager(Options{Store: NewMemoryStore(), KDFTarget: time.Millisecond, EnvelopeV2: new(true)})
	for _, recovery := range []bool{false, true} {
		secret, kind := pass, KindPassphrase
		if recovery {
			secret, kind = mat.RecoveryKey, KindRecovery
		}
		res, err := dev.UnlockWith(vaultID, mat.Envelopes, secret, recovery, UnlockOptions{})
		if err != nil || res.Upgrade == nil || string(res.Upgrade.Kind) != kind {
			t.Fatalf("%s: no upgrade proposed: %+v %v", kind, res, err)
		}
		up := *res.Upgrade
		if vaultcrypto.EnvelopeVersion(up.WrappedVmk) != 2 || up.Kdf.Salt != envelopeOf(t, mat.Envelopes, kind).Kdf.Salt {
			t.Fatalf("%s: upgrade must be v2 with the same KDF parameters", kind)
		}
		next, _, _ := newManager(t)
		res, err = next.UnlockWith(vaultID, replaceEnvelope(mat.Envelopes, up), secret, recovery, UnlockOptions{})
		if err != nil || res.Version != 2 || res.Upgrade != nil {
			t.Fatalf("%s: upgraded envelope: %+v %v", kind, res, err)
		}
	}
	if env, err := dev.NewPassphraseEnvelope(vaultID, "a brand new passphrase"); err != nil || vaultcrypto.EnvelopeVersion(env.WrappedVmk) != 2 {
		t.Fatalf("flag on must write v2: %v", err)
	}
	if env, _, err := dev.NewRecoveryEnvelope(vaultID); err != nil || vaultcrypto.EnvelopeVersion(env.WrappedVmk) != 2 {
		t.Fatalf("flag on must write a v2 recovery envelope: %v", err)
	}
}

// A passphrase envelope written before NFC normalization, from the raw bytes
// of a decomposed input, still opens with either form; with v2 writing on the
// upgrade re-wraps it under the NFC form.
func TestLegacyNonNFCPassphrase(t *testing.T) {
	const nfc = "café crème brûlée"
	nfd := norm.NFD.String(nfc)
	vmk, _ := vaultcrypto.GenerateVMK()
	kdf := vaultcrypto.NewPassphraseKDF(0, 0, 0)
	raw, err := vaultcrypto.DeriveKEKPassphraseRaw(nfd, kdf)
	if err != nil {
		t.Fatal(err)
	}
	w, _ := vaultcrypto.Wrap(raw, vmk)
	legacy := []transport.KeyEnvelope{{Kind: KindPassphrase, Kdf: kdfToTransport(kdf), WrappedVmk: w}}
	for _, typed := range []string{nfd, nfc} {
		m, _, _ := newManager(t)
		m.SetEnvelopeV2(false) // the release N behavior: a legacy envelope stays as it is
		res, err := m.UnlockWith(vaultID, legacy, typed, false, UnlockOptions{})
		if err != nil || !res.Legacy || res.Upgrade != nil {
			t.Fatalf("legacy envelope typed as %+q: %+v %v", typed, res, err)
		}
		if err := m.VerifyPassphrase(vaultID, legacy, typed); err != nil {
			t.Fatalf("verify legacy: %v", err)
		}
	}
	dev := NewManager(Options{Store: NewMemoryStore(), KDFTarget: time.Millisecond, EnvelopeV2: new(true)})
	res, err := dev.UnlockWith(vaultID, legacy, nfd, false, UnlockOptions{})
	if err != nil || res.Upgrade == nil {
		t.Fatalf("legacy upgrade: %+v %v", res, err)
	}
	up := []transport.KeyEnvelope{*res.Upgrade}
	vid, _ := vaultcrypto.ParseUUID(vaultID)
	nfcKEK, _ := vaultcrypto.DeriveKEKPassphrase(nfc, kdf)
	if got, err := vaultcrypto.Unwrap(nfcKEK, res.Upgrade.WrappedVmk, vid, vaultcrypto.KindPassphrase); err != nil || got != vmk {
		t.Fatalf("upgrade not under the NFC key: %v", err)
	}
	m, _, _ := newManager(t)
	if res, err := m.UnlockWith(vaultID, up, nfd, false, UnlockOptions{}); err != nil || res.Legacy {
		t.Fatalf("upgraded envelope: %+v %v", res, err)
	}
}
