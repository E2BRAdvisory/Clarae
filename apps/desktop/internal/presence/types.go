// Package presence is the client side of live presence on shared vaults (ADR-0065, M25): who else has
// the same document open, and where their cursor is. It keeps one WebSocket per account, open only
// while a file of a shared vault is watched, and tells the UI through events. Presence is not
// saved, not audited and never concerns a private vault.
//
// The package is the same on the desktop and in the WebAssembly core: the WebSocket is the one of
// the platform (transport.PresenceConn).
package presence

import (
	"encoding/json"
	"fmt"
	"math"

	"clarae/apps/desktop/internal/events"
	"clarae/apps/desktop/internal/sync/transport"
)

// Kinds of position.
const (
	// PosText is a position in a text document: line and col (1-based line, 0-based column).
	PosText = "text"
	// PosScene is a position on a drawing or a canvas: x and y in scene coordinates.
	PosScene = "scene"
)

// Reasons Watch gives when it does not watch the file.
const (
	// ReasonNotShared: the vault is private, not linked to the cloud, or a revoked mount.
	ReasonNotShared = "not-shared"
	// ReasonNotSynced: the file has no id on the server yet; watch it again once it is synced.
	ReasonNotSynced = "not-synced"
	// ReasonDisabled: the profile (or the server) has features.presence off.
	ReasonDisabled = "disabled"
	// ReasonOffline: not signed in to the cloud.
	ReasonOffline = "offline"
)

// Pos is where a user is in a document. Kind says which of the other fields count.
type Pos struct {
	Kind string  `json:"kind"`
	Line int     `json:"line"`
	Col  int     `json:"col"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

// wire is the opaque `pos` of the protocol (at most 256 bytes).
func (p Pos) wire() (json.RawMessage, error) {
	switch p.Kind {
	case PosText:
		return json.Marshal(struct {
			K    string `json:"k"`
			Line int    `json:"line"`
			Col  int    `json:"col"`
		}{PosText, p.Line, p.Col})
	case PosScene:
		if math.IsNaN(p.X) || math.IsInf(p.X, 0) || math.IsNaN(p.Y) || math.IsInf(p.Y, 0) {
			return nil, fmt.Errorf("presence: the position is not finite")
		}
		return json.Marshal(struct {
			K string  `json:"k"`
			X float64 `json:"x"`
			Y float64 `json:"y"`
		}{PosScene, p.X, p.Y})
	}
	return nil, fmt.Errorf("presence: unknown position kind %q", p.Kind)
}

func posFromWire(b json.RawMessage) (Pos, bool) {
	var w struct {
		K    string  `json:"k"`
		Line int     `json:"line"`
		Col  int     `json:"col"`
		X    float64 `json:"x"`
		Y    float64 `json:"y"`
	}
	if len(b) > 256 || json.Unmarshal(b, &w) != nil || (w.K != PosText && w.K != PosScene) {
		return Pos{}, false
	}
	return Pos{Kind: w.K, Line: w.Line, Col: w.Col, X: w.X, Y: w.Y}, true
}

// Watching is the answer of Watch: whether the file is watched, and why not.
type Watching struct {
	Watching bool   `json:"watching"`
	Reason   string `json:"reason"`
}

// Member is another user who has the document open (one entry per connection of theirs).
type Member struct {
	SID    string `json:"sid"`
	UserID string `json:"userId"`
	Name   string `json:"name"`
}

// MembersChanged carries the others who have the file open, after a change.
type MembersChanged struct {
	VaultID string   `json:"vaultId"`
	Path    string   `json:"path"`
	Members []Member `json:"members"`
}

// MemberMoved is the new position of one of the members.
type MemberMoved struct {
	VaultID string `json:"vaultId"`
	Path    string `json:"path"`
	SID     string `json:"sid"`
	Pos     Pos    `json:"pos"`
}

// Cleared says that nothing is known about the file any more (connection lost, presence stopped,
// share revoked): drop the avatars and the cursors.
type Cleared struct {
	VaultID string `json:"vaultId"`
	Path    string `json:"path"`
}

// Events of the presence channel (listed in the registry of internal/app/events_registry.go).
var (
	EventMembers = events.New[MembersChanged]("presence:members",
		"The other users who have a watched file open (PresenceAPI.Watch), after a change. The own session and the other\n"+
			"devices of the same user are left out. The list is complete, not a delta.")
	EventMove = events.New[MemberMoved]("presence:move",
		"Another user moved their cursor in a watched file. Coalesced (about 25 per second at most, the last position wins).")
	EventCleared = events.New[Cleared]("presence:cleared",
		"Nothing is known about a watched file any more (connection lost, presence off, share revoked): drop its avatars and cursors.")
)

func memberOf(m transport.PresenceMember) Member {
	return Member{SID: m.SID, UserID: m.UserID, Name: m.Name}
}
