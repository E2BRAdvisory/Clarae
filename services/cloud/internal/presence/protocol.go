package presence

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Limits of the protocol (M25 «Contratto»).
const (
	// MaxFrameBytes bounds every client frame except auth.
	MaxFrameBytes = 1024
	// MaxAuthFrameBytes bounds the auth frame, which carries an access token: a
	// Keycloak JWT is often larger than 1 KiB.
	MaxAuthFrameBytes = 8 << 10
	// MaxPosBytes bounds the opaque position of a move.
	MaxPosBytes = 256
	// MaxMovesPerSecond is the sustained rate of move frames per connection;
	// beyond it the latest position is held and sent when the budget allows.
	MaxMovesPerSecond = 40
	// MaxConnsPerUser caps the connections of one user on one replica.
	MaxConnsPerUser = 32
	// MaxRoomsPerConn caps the rooms one connection is in.
	MaxRoomsPerConn = 16
	// MaxNameBytes bounds the display name stamped on a member.
	MaxNameBytes = 128

	// PingEvery is the interval of the WebSocket pings (a proxy idle timeout is
	// typically 60 s).
	PingEvery = 30 * time.Second
	// PingTimeout is how long a pong may take before the connection is dropped.
	PingTimeout = 20 * time.Second
	// AuthTimeout is how long a new connection has to send its auth frame.
	AuthTimeout = 10 * time.Second
	// RecheckEvery is the period of the authorization recheck of every room, a
	// net under the share, account and configuration events.
	RecheckEvery = time.Minute
	// MoveFlushEvery spaces the move frames sent to one client and the
	// notifications between replicas (about 15 Hz).
	MoveFlushEvery = 66 * time.Millisecond
)

// Frame types and error codes.
const (
	TAuth    = "auth"
	TJoin    = "join"
	TLeave   = "leave"
	TMove    = "move"
	TPing    = "ping"
	TReady   = "ready"
	TMembers = "members"
	TJoined  = "joined"
	TLeft    = "left"
	TError   = "error"
	TPong    = "pong"

	CodeDisabled     = "presence-disabled"
	CodeUnauth       = "unauthenticated"
	CodeSuspended    = "user-suspended"
	CodeNotFound     = "not-found"
	CodeEncrypted    = "vault-encrypted"
	CodeForbidden    = "forbidden"
	CodeTooManyConns = "rate-limited"
	CodeTooManyRooms = "too-many-rooms"
	CodeNotJoined    = "not-joined"
	CodeBadFrame     = "bad-frame"
	CodeTooLarge     = "frame-too-large"
	CodeTokenExpired = "token-expired"
	CodeSlow         = "slow-consumer"
	CodeInternal     = "internal"
)

// Room is the unit of presence: one file of one cloud vault.
type Room struct {
	Vault uuid.UUID `json:"vault"`
	File  uuid.UUID `json:"file"`
}

// Member is who is in a room, as the server stamps it.
type Member struct {
	SID  string    `json:"sid"`
	User uuid.UUID `json:"user_id"`
	Name string    `json:"name"`
}

type inFrame struct {
	T     string          `json:"t"`
	Token string          `json:"token,omitempty"`
	Room  *Room           `json:"room,omitempty"`
	Pos   json.RawMessage `json:"pos,omitempty"`
}

type outFrame struct {
	T      string          `json:"t"`
	SID    string          `json:"sid,omitempty"`
	Room   *Room           `json:"room,omitempty"`
	List   []Member        `json:"list,omitempty"`
	Member *Member         `json:"member,omitempty"`
	Pos    json.RawMessage `json:"pos,omitempty"`
	Code   string          `json:"code,omitempty"`
}

func marshal(f outFrame) []byte {
	if f.T == TMembers && f.List == nil {
		f.List = []Member{}
	}
	b, _ := json.Marshal(f) // only strings, UUIDs and valid raw JSON
	return b
}
