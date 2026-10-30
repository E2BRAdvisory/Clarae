package crypto

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
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
	tok, key, err := c.EncryptPath("Journal/Day 1.md")
	if err != nil || key == "" {
		t.Fatal(err)
	}
	if got, err := c.DecryptPath(tok); err != nil || got != "Journal/Day 1.md" {
		t.Fatalf("path: %q %v", got, err)
	}
	_, key2, _ := c.EncryptPath("journal/day 1.md")
	if key != key2 {
		t.Error("case variants must share the path key")
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

func TestPassphrasePolicy(t *testing.T) {
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

func TestIdleTimeoutLocks(t *testing.T) {
	m, _, now := newManager(t)
	m.SetLockTimeout(10 * time.Minute)
	mat, _ := m.NewMaterial("correct horse battery staple")
	_ = m.Adopt(vaultID, mat)
	*now = now.Add(9 * time.Minute)
	if m.IsLocked(vaultID) {
		t.Fatal("locked too early")
	}
	// Using the vault resets the idle timer.
	if _, _, err := m.Cipher(vaultID).EncryptPath("a.md"); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(9 * time.Minute)
	if m.IsLocked(vaultID) {
		t.Fatal("activity did not postpone the lock")
	}
	*now = now.Add(11 * time.Minute)
	if !m.IsLocked(vaultID) {
		t.Fatal("not locked after the idle timeout")
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
