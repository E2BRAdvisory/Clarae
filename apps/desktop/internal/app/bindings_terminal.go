//go:build !js

package app

import (
	"errors"
	"os"

	"clarae/apps/desktop/internal/terminal"
)

// TerminalAPI is the integrated terminal (M23, ADR-0064): shells on pseudo-terminals that the core
// starts and the UI draws. The UI never names a program or a path:
//
//   - Open takes a vault id and the core resolves the directory from the vaults that are open: the
//     root of that vault. A vault that is read-only for the user (a share as viewer, or one that was
//     revoked) is refused with terminal-read-only, because a shell would write where the application
//     does not. An id that is not an open vault (or empty) opens the home directory.
//   - Write sends keystrokes, Resize tells the size of the panel, Close ends a session and every
//     process it started. List, Snapshot and State let a window that takes the panel over redraw it.
//   - Undock moves the panel to a window of its own, Dock back; the shells go on in both cases.
//     Closing the separate window with the button of the system ends every session.
//
// The output comes as terminal:output {id, seq, data} events (coalesced, `data` valid UTF-8 text); a
// session ends with terminal:exit {id, code, reason}; terminal:layout {mode} says where the panel is.
// A vault that becomes read-only while a session of it runs ends the session (terminal:exit, reason
// "read-only"). Events go to every window: the one that does not own the panel ignores them.
//
// Every method answers errors as "<code>: <text>" (ErrCodeTerminal*). Capability: terminal.
type TerminalAPI struct{ app *App }

// NewTerminalAPI binds the API.
func NewTerminalAPI(a *App) *TerminalAPI { return &TerminalAPI{app: a} }

// Open starts a shell for the vault (see the type) at the size of the panel, in columns and rows.
func (t *TerminalAPI) Open(vaultID string, cols, rows int) (TerminalSession, error) {
	m := t.app.terminal.m
	cwd, vid, err := t.app.terminalDir(vaultID)
	if err != nil {
		return TerminalSession{}, err
	}
	info, err := m.Open(vid, cwd, cols, rows)
	if err != nil {
		return TerminalSession{}, t.fail(err)
	}
	// The share may have been lowered while the shell was starting: the hook of the sync manager
	// found no session of the vault to end yet.
	if vid != "" && t.app.vaultReadOnly(vid) {
		_ = m.Close(info.ID)
		return TerminalSession{}, errTerminalReadOnly
	}
	return sessionOf(info), nil
}

// CanOpen says whether Open would start a shell for the vault: not when the vault is read-only for
// the user. The UI disables the button with it (SyncAPI.Info says the same in readOnly).
func (t *TerminalAPI) CanOpen(vaultID string) (TerminalOpenCheck, error) {
	if t.app.terminalReadOnly(vaultID) {
		return TerminalOpenCheck{Reason: terminalReasonReadOnly}, nil
	}
	return TerminalOpenCheck{Allowed: true}, nil
}

// Write sends what the user typed (or pasted) to the shell. At most 1 MiB per call.
func (t *TerminalAPI) Write(id, data string) error {
	return t.fail(t.app.terminal.m.Write(id, data))
}

// Resize sets the size of the pseudo-terminal, in columns and rows.
func (t *TerminalAPI) Resize(id string, cols, rows int) error {
	return t.fail(t.app.terminal.m.Resize(id, cols, rows))
}

// Close ends the session and everything it started; a session that is already gone is not an error.
// It returns when the processes are gone (at most a couple of seconds).
func (t *TerminalAPI) Close(id string) error {
	return t.fail(t.app.terminal.m.Close(id))
}

// List returns the sessions that are open, oldest first.
func (t *TerminalAPI) List() ([]TerminalSession, error) {
	infos := t.app.terminal.m.List()
	out := make([]TerminalSession, len(infos))
	for i, in := range infos {
		out[i] = sessionOf(in)
	}
	return out, nil
}

// Snapshot returns what a session has shown (see TerminalSnapshot), for a window that takes the tab over.
func (t *TerminalAPI) Snapshot(id string) (TerminalSnapshot, error) {
	s, err := t.app.terminal.m.Snapshot(id)
	if err != nil {
		return TerminalSnapshot{}, t.fail(err)
	}
	return TerminalSnapshot{Data: s.Data, Seq: s.Seq}, nil
}

// State says where the panel is shown.
func (t *TerminalAPI) State() (TerminalState, error) {
	return TerminalState{Mode: string(t.app.terminal.m.State())}, nil
}

// Undock moves the panel to the separate window (opening it, or bringing it forward); the sessions go on.
func (t *TerminalAPI) Undock() error { return t.fail(t.app.terminal.m.Undock()) }

// Dock moves the panel back to the main window and closes the separate one; the sessions go on.
func (t *TerminalAPI) Dock() error { return t.fail(t.app.terminal.m.Dock()) }

var errTerminalReadOnly = coded(ErrCodeTerminalReadOnly, "this vault is read-only for you: a terminal would let a shell change what the application does not", nil)

func sessionOf(in terminal.Info) TerminalSession {
	return TerminalSession{ID: in.ID, VaultID: in.VaultID, Cwd: in.Cwd, Shell: in.Shell, Title: in.Title}
}

// fail gives an error of internal/terminal the code the UI branches on.
func (t *TerminalAPI) fail(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, terminal.ErrNotFound):
		return coded(ErrCodeTerminalNotFound, "no such terminal session", err)
	case errors.Is(err, terminal.ErrLimit):
		return coded(ErrCodeTerminalLimit, "too many terminals are open", err)
	case errors.Is(err, terminal.ErrBusy):
		return coded(ErrCodeTerminalBusy, "the shell is not reading its input", err)
	case errors.Is(err, terminal.ErrTooLarge):
		return coded(ErrCodeTerminalTooLarge, "too much input at once", err)
	}
	logBindingError(err)
	return coded(ErrCodeTerminalFailed, "the terminal could not do it; see the log", err)
}

// terminalDir resolves where a session for the vault starts: the root of the vault when it is open, the
// home directory when it is not (or the id is empty or unknown), and an error when the vault is read-only.
// It returns the id of the vault the session belongs to ("" for the home directory).
func (a *App) terminalDir(vaultID string) (dir, vid string, err error) {
	if a.terminalReadOnly(vaultID) {
		return "", "", errTerminalReadOnly
	}
	if v, verr := a.vault(vaultID); vaultID != "" && verr == nil && v.Info.Path != "" {
		if fi, serr := os.Stat(v.Info.Path); serr == nil && fi.IsDir() {
			return v.Info.Path, vaultID, nil
		}
	}
	home, herr := a.terminal.m.Home()
	if herr != nil {
		return "", "", coded(ErrCodeTerminalFailed, "the home directory is not known", herr)
	}
	return home, "", nil
}

// terminalReasonReadOnly is TerminalOpenCheck.Reason of a vault the user may only read.
const terminalReasonReadOnly = "read-only"

// terminalReadOnly reports whether vaultID is an open vault that is read-only for the user.
func (a *App) terminalReadOnly(vaultID string) bool {
	if vaultID == "" {
		return false
	}
	_, err := a.vault(vaultID)
	return err == nil && a.vaultReadOnly(vaultID)
}

// vaultReadOnly reports whether the user may not change the vault (a viewer of a share, or a revoked one).
func (a *App) vaultReadOnly(vaultID string) bool {
	return a.sync.ReadOnly(a.ctxOrBackground(), vaultID)
}
