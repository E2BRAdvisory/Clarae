//go:build !js

// Package terminal runs the shells of the integrated terminal (M23, ADR-0064): one pseudo-terminal
// per tab, owned by a Manager that the desktop core keeps for the whole process. The frontend never
// starts a process by itself and never names a program or a path: it asks the core for a session
// (TerminalAPI in internal/app, which resolves the directory from an open vault) and then writes
// keystrokes to it and draws the output it hears about.
//
// # Output
//
// The output of a session is read by one goroutine, coalesced (a flush every FlushDelay, or as soon
// as FlushBytes are waiting) and sent as the event terminal:output {id, seq, data}. `data` is a JSON
// string, so it is always valid UTF-8: a multibyte sequence that a read splits in two is held back
// until the next flush, and bytes that are not UTF-8 become U+FFFD. `seq` counts the events of a
// session from 1. What was sent is also kept in a ring buffer of RingSize bytes, the same text:
// Snapshot returns it with the `seq` of the last event it contains, so a window that takes over
// a tab (the panel moves to the separate window and back) draws the snapshot and ignores the events
// with a `seq` not greater than the snapshot's. The shell is never told that anything moved.
//
// # Processes
//
// On Unix the shell is a session leader on its own pseudo-terminal (creack/pty: Setsid, Setctty),
// so its process group is its own: closing a session sends SIGHUP to the group, waits up to KillAfter
// for it to go and then sends SIGKILL, so a background job that ignores SIGHUP does not outlive the
// tab. On Windows the shell runs on a ConPTY inside a Job Object with KILL_ON_JOB_CLOSE: closing
// the session ends the job, and so does the death of the application. The ending of the shell
// is the end of the session (terminal:exit), whether the user typed `exit` or the tab was closed.
//
// # Windows of the panel
//
// The Manager also keeps where the panel lives (docked in the main window, or detached in a window
// of its own, Mode). Opening and closing that window is the host's business (Window); closing it
// with the button of the system ends every session (WindowClosedBySystem).
package terminal
