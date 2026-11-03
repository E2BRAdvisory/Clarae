package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/links"
	"memobrain/apps/desktop/internal/vault"
)

// Every binding that sets a new passphrase applies the policy in the core and
// answers "weak-passphrase: <reason>: <text>", whatever the UI checked before;
// the check runs before anything else (no session, no linked vault needed).
func TestWeakPassphraseBindings(t *testing.T) {
	a, info, _ := newTestApp(t)
	s := NewSyncAPI(a)
	c := NewVaultCryptoAPI(a)
	for name, call := range map[string]func(pass string) error{
		"link new": func(p string) error { _, err := s.LinkNew(info.ID, "Diary", "private", p); return err },
		"set":      func(p string) error { return c.SetPassphrase(info.ID, p) },
		"change": func(p string) error {
			return c.ChangePassphrase(info.ID, "the old one does not matter", p)
		},
	} {
		for pass, reason := range map[string]string{
			"short":            crypto.WeakTooShort,
			"passwordpassword": crypto.WeakGuessable,
		} {
			err := call(pass)
			want := ErrCodeWeakPassphrase + ": " + reason + ": "
			if err == nil || !strings.HasPrefix(err.Error(), want) {
				t.Errorf("%s(%q): %v, want %q…", name, pass, err, want)
			}
		}
		// A strong passphrase passes the policy and fails further on (no
		// session, vault not linked), never as a weak passphrase.
		if err := call("correct horse battery staple"); err == nil || strings.HasPrefix(err.Error(), ErrCodeWeakPassphrase) {
			t.Errorf("%s: strong passphrase: %v", name, err)
		}
	}
	// A shared vault has no passphrase: nothing to check.
	if _, err := s.LinkNew(info.ID, "Team", "shared", ""); err != nil && strings.HasPrefix(err.Error(), ErrCodeWeakPassphrase) {
		t.Errorf("shared vault: %v", err)
	}
	got := bindingError(fmt.Errorf("link: %w", crypto.ErrShortPassphrase)).Error()
	if got != "weak-passphrase: too-short: the passphrase must have at least 12 characters" {
		t.Errorf("message %q", got)
	}
}

// Binding errors carry a stable code and never an absolute path or SQL.
func TestBindingErrorContract(t *testing.T) {
	home := filepath.Join(string(filepath.Separator)+"Users", "ada", "Vault")
	_, statErr := os.Stat(filepath.Join(home, "missing.md"))
	permErr := &os.PathError{Op: "open", Path: filepath.Join(home, "x.md"), Err: os.ErrPermission}
	ioErr := &os.PathError{Op: "write", Path: filepath.Join(home, "x.md"), Err: errors.New("input/output error")}
	cases := []struct {
		err  error
		code string
	}{
		{vault.ErrHashMismatch, ErrCodeConflict},
		{fmt.Errorf("unlock: %w", crypto.ErrWrongSecret), ErrCodeWrongSecret},
		{fmt.Errorf("%w: a.md", links.ErrStalePlan), ErrCodeConflict},
		{vault.ErrExists, ErrCodeExists},
		{statErr, ErrCodeNotFound},
		{vault.ErrOutsideVault, ErrCodeInvalidPath},
		{permErr, ErrCodePermission},
		{ioErr, ErrCodeIO},
		{errors.Join(errors.New("move failed"), links.ErrPartialRollback, errors.New(home+"/b.md not restored")), ErrCodePartial},
		{errors.New("SQL logic error: no such column: body_bytes (1)"), ErrCodeInternal},
		{fmt.Errorf("sql: Scan error on column index 0"), ErrCodeInternal},
	}
	for _, c := range cases {
		got := bindingError(c.err)
		msg := got.Error()
		if !strings.HasPrefix(msg, c.code+": ") {
			t.Errorf("%v -> %q, want code %s", c.err, msg, c.code)
		}
		if strings.Contains(msg, "/Users/") || strings.Contains(msg, "SQL") || strings.Contains(msg, "column") {
			t.Errorf("%v -> %q leaks details", c.err, msg)
		}
		if !errors.Is(got, c.err) && !errors.Is(got, errors.Unwrap(c.err)) {
			t.Errorf("%v: cause lost", c.err)
		}
	}
	// The messages the workbench's Wails mock answers with.
	for err, want := range map[error]string{
		vault.ErrHashMismatch: "conflict: file changed on disk",
		vault.ErrExists:       "exists: destination already exists",
		statErr:               "not-found: no such file",
		crypto.ErrWrongSecret: "wrong-secret: wrong passphrase or recovery key",
	} {
		if got := bindingError(err).Error(); got != want {
			t.Errorf("%q, want %q", got, want)
		}
	}
	if bindingError(nil) != nil {
		t.Fatal("nil must stay nil")
	}
}

// New notes, folders and rename destinations with a Windows device name are
// refused with invalid-path; existing files keep working.
func TestNewNamesMustBePortable(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)
	l := NewLinksAPI(a)
	if _, err := v.WriteNote(info.ID, "ok.md", "x", ""); err != nil {
		t.Fatal(err)
	}
	for name, call := range map[string]func() error{
		"create":       func() error { _, err := v.WriteNote(info.ID, "Notes/COM¹.md", "x", ""); return err },
		"folder":       func() error { return v.CreateFolder(info.ID, "nul") },
		"rename":       func() error { return v.Rename(info.ID, "ok.md", "aux .md") },
		"plan rename":  func() error { _, err := l.PlanRename(info.ID, "ok.md", "LPT1.txt.md"); return err },
		"apply rename": func() error { _, err := l.ApplyRename(info.ID, "ok.md", "con.md"); return err },
	} {
		if err := call(); err == nil || !strings.HasPrefix(err.Error(), ErrCodeInvalidPath+": ") {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := v.Rename(info.ID, "ok.md", "fine.md"); err != nil {
		t.Fatal(err)
	}
}
