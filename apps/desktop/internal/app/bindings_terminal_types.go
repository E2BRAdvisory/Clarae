package app

// The types of TerminalAPI, shared by the desktop (bindings_terminal.go) and the browser stub
// (bindings_terminal_js.go): both hosts expose the same bindings and the same models.

// TerminalSession describes a shell of the integrated terminal.
type TerminalSession struct {
	// ID names the session in every other call and in the terminal:* events.
	ID string `json:"id"`
	// VaultID is the vault the session was opened for ("" = the home directory).
	VaultID string `json:"vaultId"`
	// Cwd is the directory the shell started in: the root of the vault, or the home directory.
	Cwd string `json:"cwd"`
	// Shell is the name of the shell program ("zsh", "pwsh.exe").
	Shell string `json:"shell"`
	// Title is the initial title of the tab: the name of the directory.
	Title string `json:"title"`
}

// TerminalSnapshot is what a session has shown so far (TerminalAPI.Snapshot).
type TerminalSnapshot struct {
	// Data is the retained output, at most 2 MiB, the same text the terminal:output events carried.
	Data string `json:"data"`
	// Seq is the seq of the last event Data contains: ignore terminal:output events up to it.
	Seq uint64 `json:"seq"`
}

// TerminalState says where the terminal panel is shown (TerminalAPI.State).
type TerminalState struct {
	// Mode is "docked" (in the main window) or "detached" (in the window of its own).
	Mode string `json:"mode"`
}

// TerminalOpenCheck answers TerminalAPI.CanOpen.
type TerminalOpenCheck struct {
	// Allowed: Open would start a shell for this vault.
	Allowed bool `json:"allowed"`
	// Reason is why not: "read-only" (the vault is a share the user may only read, or one that was revoked).
	Reason string `json:"reason"`
}
