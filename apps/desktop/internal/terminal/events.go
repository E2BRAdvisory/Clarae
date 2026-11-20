//go:build !js

package terminal

import "clarae/apps/desktop/internal/events"

// Mode says where the terminal panel is shown.
type Mode string

const (
	// ModeDocked: the panel is in the main window.
	ModeDocked Mode = "docked"
	// ModeDetached: the panel is in the window of its own.
	ModeDetached Mode = "detached"
)

// ExitReason says why a session ended.
type ExitReason string

const (
	// ReasonExited: the shell ended by itself (the user typed `exit`, or it crashed).
	ReasonExited ExitReason = "exited"
	// ReasonClosed: the UI closed the session (Close, the tab was closed).
	ReasonClosed ExitReason = "closed"
	// ReasonReadOnly: the vault of the session became read-only (a share was revoked, or lowered to viewer).
	ReasonReadOnly ExitReason = "read-only"
	// ReasonWindowClosed: the user closed the separate window with the button of the system.
	ReasonWindowClosed ExitReason = "window-closed"
)

// The events of the terminal. They go to every window; the one that owns the panel (terminal:layout)
// draws them and the other ignores them.
var (
	EventOutput = events.New[OutputPayload]("terminal:output",
		"Desktop: output of a terminal session, coalesced (about 16 ms or 32 KiB). `data` is valid UTF-8 text; `seq` counts the\n"+
			"events of the session from 1 and is what Snapshot compares against: ignore an event with a seq not greater than the snapshot's.")
	EventExit = events.New[ExitPayload]("terminal:exit",
		"Desktop: a terminal session ended (the shell exited, the UI closed it, or the core did: see `reason`). No output follows.")
	EventLayout = events.New[LayoutPayload]("terminal:layout",
		"Desktop: the terminal panel moved to the separate window (`detached`) or back to the main window (`docked`).")
)

// OutputPayload accompanies EventOutput.
type OutputPayload struct {
	ID   string `json:"id"`
	Seq  uint64 `json:"seq"`
	Data string `json:"data"`
}

// ExitPayload accompanies EventExit.
type ExitPayload struct {
	ID string `json:"id"`
	// Code is the exit status of the shell (128 + the signal when it was killed).
	Code   int        `json:"code"`
	Reason ExitReason `json:"reason"`
}

// LayoutPayload accompanies EventLayout.
type LayoutPayload struct {
	Mode Mode `json:"mode"`
}
