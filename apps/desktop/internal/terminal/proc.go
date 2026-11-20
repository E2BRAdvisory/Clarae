//go:build !js

package terminal

import "io"

// proc is a shell on a pseudo-terminal, as the platform gives it (pty_unix.go, pty_windows.go).
type proc interface {
	// Read and Write are the output and the input of the shell. Read returns an error when the
	// pseudo-terminal is closed or the shell and everything that held it open are gone.
	io.Reader
	io.Writer
	// Resize sets the size of the terminal.
	Resize(cols, rows int) error
	// Wait blocks until the shell ends and returns its exit status. Called once.
	Wait() int
	// Hangup asks the shell and its group to end (SIGHUP on Unix; on Windows the job is ended).
	Hangup()
	// Alive reports whether anything of the group still runs. Once it has said no it says no for ever,
	// and Hangup and Kill do nothing: a number of a group that is gone may be used again.
	Alive() bool
	// Kill ends the shell and its group without asking.
	Kill()
	// Close closes the pseudo-terminal, waking a Read that waits.
	Close() error
}
