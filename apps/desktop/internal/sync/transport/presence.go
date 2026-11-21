package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// The presence channel (ADR-0065, M25): a WebSocket on GET /api/v1/presence, outside the generated
// router like /events. The same code runs on the desktop and, with the browser's WebSocket
// (coder/websocket has a js implementation), in the WebAssembly core. The browser cannot set headers
// on a WebSocket, so the token travels in the first frame, never in the URL.

// PresencePath is the route of the presence channel.
const PresencePath = "/presence"

// maxPresenceFrame bounds a frame received from the server (a member list of a crowded room is the largest).
const maxPresenceFrame = 256 << 10

// Error codes of the presence channel that the client acts on.
const (
	// PresenceCodeDisabled: the cloud has features.presence off; the client stops.
	PresenceCodeDisabled = "presence-disabled"
	// PresenceCodeSuspended: the account is suspended; the client stops until the session changes.
	PresenceCodeSuspended = "user-suspended"
	// Codes of an error frame that names a room: the connection stays open, only that room is affected.
	PresenceCodeForbidden    = "forbidden"
	PresenceCodeNotFound     = "not-found"
	PresenceCodeEncrypted    = "vault-encrypted"
	PresenceCodeTooManyRooms = "too-many-rooms"
	PresenceCodeNotJoined    = "not-joined"
)

// Close codes of the server (the reason carries the error code).
const (
	closeUnauthenticated websocket.StatusCode = 4401
	closeForbidden       websocket.StatusCode = 4403
	closeRateLimited     websocket.StatusCode = 1013
)

// ErrPresenceStopped is returned by Read when the server ended the channel for a reason that a
// reconnection does not cure (presence-disabled, user-suspended): Code says which.
type ErrPresenceStopped struct{ Code string }

func (e ErrPresenceStopped) Error() string { return "presence: stopped by the server: " + e.Code }

// ErrPresenceRateLimited is returned by Read when the server closed the channel with 1013: retry later.
var ErrPresenceRateLimited = errors.New("presence: rate limited")

// ErrPresenceAuth is returned by Read when the server refuses the token (an error frame with
// unauthenticated or token-expired, a close 4401, an HTTP 401 on the upgrade): the token was
// forgotten, so the next dial gets a new one.
var ErrPresenceAuth = errors.New("presence: the token was refused")

// PresenceRoom names the document a client is on: the cloud vault and the file (UUID of the server,
// the same for the owner and for the mount of a folder).
type PresenceRoom struct {
	Vault string `json:"vault"`
	File  string `json:"file"`
}

// PresenceMember is a client connected to a room; the server stamps the identity.
type PresenceMember struct {
	SID    string `json:"sid"`
	UserID string `json:"user_id"`
	Name   string `json:"name"`
}

// PresenceFrame is a frame of the channel in either direction; T says which fields count.
type PresenceFrame struct {
	T      string           `json:"t"`
	Token  string           `json:"token,omitempty"`  // auth
	SID    string           `json:"sid,omitempty"`    // ready, left, move
	Room   *PresenceRoom    `json:"room,omitempty"`   // join, leave, move, members, joined, left
	Pos    json.RawMessage  `json:"pos,omitempty"`    // move (opaque, at most 256 bytes)
	List   []PresenceMember `json:"list,omitempty"`   // members
	Member *PresenceMember  `json:"member,omitempty"` // joined
	Code   string           `json:"code,omitempty"`   // error
}

// PresenceConn is an open presence channel. Read, Send and Reauth may run on different goroutines,
// one each at a time.
type PresenceConn struct {
	c   *Client
	ws  *websocket.Conn
	tok string
	exp time.Time
}

// DialPresence opens the channel and sends the authentication frame.
func (c *Client) DialPresence(ctx context.Context) (*PresenceConn, error) {
	if c.tokens == nil {
		return nil, errors.New("presence: no token source")
	}
	tok, err := c.tokens.Token(ctx)
	if err != nil {
		return nil, err
	}
	ws, resp, err := websocket.Dial(ctx, c.base.String()+BasePath+PresencePath, c.presenceDialOptions())
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			c.invalidateToken(tok)
			return nil, ErrPresenceAuth
		}
		return nil, fmt.Errorf("presence: %w", err)
	}
	ws.SetReadLimit(maxPresenceFrame)
	pc := &PresenceConn{c: c, ws: ws}
	if err := pc.sendAuth(ctx, tok); err != nil {
		_ = ws.CloseNow()
		return nil, err
	}
	return pc, nil
}

func (p *PresenceConn) sendAuth(ctx context.Context, tok string) error {
	p.tok, p.exp = tok, tokenExpiry(tok)
	return p.Send(ctx, PresenceFrame{T: "auth", Token: tok})
}

// Reauth sends a new token before the current one expires.
func (p *PresenceConn) Reauth(ctx context.Context) error {
	tok, err := p.c.tokens.Token(ctx)
	if err != nil {
		return err
	}
	return p.sendAuth(ctx, tok)
}

// RenewAt is when the token in force must be replaced: a minute before it expires, or in four
// minutes for a token that says nothing (the server decides anyway).
func (p *PresenceConn) RenewAt() time.Time {
	if p.exp.IsZero() {
		return time.Now().Add(4 * time.Minute)
	}
	return p.exp.Add(-time.Minute)
}

// Send writes a frame.
func (p *PresenceConn) Send(ctx context.Context, f PresenceFrame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return p.ws.Write(wctx, websocket.MessageText, b)
}

// Read waits for the next frame. A refused token comes back as ErrPresenceAuth (and is forgotten).
func (p *PresenceConn) Read(ctx context.Context) (PresenceFrame, error) {
	for {
		typ, b, err := p.ws.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				switch ce.Code {
				case closeUnauthenticated:
					p.c.invalidateToken(p.tok)
					return PresenceFrame{}, ErrPresenceAuth
				case closeForbidden:
					return PresenceFrame{}, ErrPresenceStopped{Code: ce.Reason}
				case closeRateLimited:
					return PresenceFrame{}, ErrPresenceRateLimited
				}
			}
			return PresenceFrame{}, err
		}
		if typ != websocket.MessageText {
			continue
		}
		var f PresenceFrame
		if json.Unmarshal(b, &f) != nil {
			continue // not a frame we know: ignore, as for a newer server
		}
		if f.T == "error" && f.Room == nil { // without a room the server closes the connection
			switch f.Code {
			case "unauthenticated", "token-expired":
				p.c.invalidateToken(p.tok)
				return f, ErrPresenceAuth
			case PresenceCodeDisabled, PresenceCodeSuspended:
				return f, ErrPresenceStopped{Code: f.Code}
			}
		}
		return f, nil
	}
}

// Close ends the channel at once.
func (p *PresenceConn) Close() { _ = p.ws.CloseNow() }

// tokenExpiry reads the exp claim of a JWT without verifying it (the server does): zero when it has none.
func tokenExpiry(tok string) time.Time {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}
	}
	var c struct {
		Exp float64 `json:"exp"`
	}
	if json.Unmarshal(b, &c) != nil || c.Exp <= 0 {
		return time.Time{}
	}
	return time.Unix(int64(c.Exp), 0)
}
