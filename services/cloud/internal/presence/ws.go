package presence

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"golang.org/x/time/rate"

	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/notify"
)

// Close codes of the application range (the code of the error frame is sent first).
const (
	closeUnauthenticated websocket.StatusCode = 4401
	closeForbidden       websocket.StatusCode = 4403
)

// Options configure Handler.
type Options struct {
	// OriginPatterns are the origins besides the host itself that may open the
	// WebSocket from a browser (the Web UI served from another origin in
	// development). A client that sends no Origin (the desktop) is always accepted.
	OriginPatterns []string
	// RecheckEvery overrides the authorization recheck period (tests).
	RecheckEvery time.Duration
	// PingEvery overrides the ping interval (tests).
	PingEvery time.Duration
	// AuthTimeout overrides how long a connection has to authenticate (tests).
	AuthTimeout time.Duration
	// VaultRecheckEvery spaces the rechecks caused by commits (zero: 5 s).
	VaultRecheckEvery time.Duration
}

// Handler serves GET /api/v1/presence. It is mounted outside the generated
// router and outside the authentication middleware: a browser cannot send an
// Authorization header on a WebSocket, so the first frame carries the token.
type Handler struct {
	env  Env
	hub  *Hub
	log  zerolog.Logger
	opts Options
}

// NewHandler creates the endpoint.
func NewHandler(env Env, hub *Hub, log zerolog.Logger, opts Options) *Handler {
	if opts.RecheckEvery <= 0 {
		opts.RecheckEvery = RecheckEvery
	}
	if opts.VaultRecheckEvery <= 0 {
		opts.VaultRecheckEvery = 5 * time.Second
	}
	if opts.AuthTimeout <= 0 {
		opts.AuthTimeout = AuthTimeout
	}
	if opts.PingEvery <= 0 {
		opts.PingEvery = PingEvery
	}
	return &Handler{env: env, hub: hub, log: log, opts: opts}
}

func newSID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// session is one connection being served.
type session struct {
	h        *Handler
	ws       *websocket.Conn
	conn     *Conn
	log      zerolog.Logger
	cancel   context.CancelCauseFunc
	failOnce sync.Once
	failed   atomic.Bool

	mu    sync.Mutex
	token string
	exp   time.Time

	moves   *rate.Limiter
	joins   *rate.Limiter
	heldMu  sync.Mutex
	held    map[Room]json.RawMessage
	heldSet bool
}

// closeError is why a session ends: the frame sent to the client and the close status.
type closeError struct {
	code   string
	status websocket.StatusCode
}

func (e *closeError) Error() string { return "presence closed: " + e.code }

// ServeHTTP implements http.Handler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:  h.opts.OriginPatterns,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return // Accept already answered
	}
	defer func() { _ = ws.CloseNow() }()
	ws.SetReadLimit(MaxAuthFrameBytes)
	// The session context is not derived from the request: cancelling a context
	// that a Read waits on closes the connection without a close frame, so
	// every orderly end goes through ws.Close first (fail, and the drain below).
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	s := &session{h: h, ws: ws, cancel: cancel, log: h.log, held: map[Room]json.RawMessage{},
		moves: rate.NewLimiter(MaxMovesPerSecond, MaxMovesPerSecond/4),
		joins: rate.NewLimiter(10, 20)}
	go func() {
		select {
		case <-r.Context().Done(): // the server is draining: tell the client to reconnect elsewhere
			_ = ws.Close(websocket.StatusGoingAway, "server shutting down")
		case <-ctx.Done():
		}
	}()
	err = s.run(ctx)
	if s.failed.Load() {
		return
	}
	var ce *closeError
	if errors.As(err, &ce) {
		s.fail(ce.code, ce.status)
		return
	}
	_ = ws.Close(websocket.StatusNormalClosure, "")
}

func (s *session) sendError(ctx context.Context, code string, room *Room) {
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	_ = s.ws.Write(wctx, websocket.MessageText, marshal(outFrame{T: TError, Code: code, Room: room}))
}

func readFrame(ctx context.Context, ws *websocket.Conn) (inFrame, int, error) {
	_, data, err := ws.Read(ctx)
	if err != nil {
		return inFrame{}, 0, err
	}
	var f inFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return inFrame{}, len(data), &closeError{CodeBadFrame, websocket.StatusPolicyViolation}
	}
	return f, len(data), nil
}

// authenticate verifies the token of an auth frame.
func (s *session) authenticate(ctx context.Context, f inFrame) (auth.Principal, time.Time, error) {
	if f.T != TAuth || f.Token == "" {
		return auth.Principal{}, time.Time{}, &closeError{CodeUnauth, closeUnauthenticated}
	}
	p, exp, err := s.h.env.Authenticate(ctx, f.Token)
	switch {
	case errors.Is(err, auth.ErrSuspended):
		return p, exp, &closeError{CodeSuspended, closeForbidden}
	case errors.Is(err, auth.ErrInvalidToken), errors.Is(err, auth.ErrIdentityConflict):
		return p, exp, &closeError{CodeUnauth, closeUnauthenticated}
	case err != nil:
		s.log.Error().Err(err).Msg("presence: authentication failed")
		return p, exp, &closeError{CodeInternal, websocket.StatusInternalError}
	}
	return p, exp, nil
}

func (s *session) run(ctx context.Context) error {
	env := s.h.env
	// The first frame authenticates; nothing else is accepted before it.
	authTimer := time.AfterFunc(s.h.opts.AuthTimeout, func() { s.fail(CodeUnauth, closeUnauthenticated) })
	f, _, err := readFrame(ctx, s.ws)
	if !authTimer.Stop() {
		return nil // the timer fired: fail() closed the connection
	}
	if err != nil {
		var ce *closeError
		if errors.As(err, &ce) {
			return &closeError{CodeUnauth, closeUnauthenticated}
		}
		return err
	}
	p, exp, err := s.authenticate(ctx, f)
	if err != nil {
		return err
	}
	if on, err := env.Enabled(ctx, p.UserID); err != nil {
		s.log.Error().Err(err).Msg("presence: cannot resolve the profile")
		return &closeError{CodeInternal, websocket.StatusInternalError}
	} else if !on {
		return &closeError{CodeDisabled, closeForbidden}
	}
	name, err := env.DisplayName(ctx, p.UserID)
	if err != nil {
		s.log.Error().Err(err).Msg("presence: cannot read the display name")
		return &closeError{CodeInternal, websocket.StatusInternalError}
	}
	name = truncateName(name)
	if !s.h.hub.Admit(p.UserID) {
		return &closeError{CodeTooManyConns, websocket.StatusTryAgainLater}
	}
	s.conn = s.h.hub.NewConn(newSID(), p.UserID, name)
	defer s.h.hub.Drop(s.conn)
	s.token, s.exp = f.Token, exp
	s.log = s.h.log.With().Str("user_id", p.UserID.String()).Str("sid", s.conn.SID).Logger()
	s.log.Debug().Msg("presence: connection opened")
	defer func() { s.log.Debug().Msg("presence: connection closed") }()

	sub, unsub := env.Subscribe(p.UserID)
	defer unsub()

	var wg sync.WaitGroup
	defer wg.Wait()
	defer s.cancel(nil)
	for _, fn := range []func(context.Context){s.writer, s.pinger, s.watch(sub), s.expiry} {
		wg.Add(1)
		go func() { defer wg.Done(); fn(ctx) }()
	}
	if err := s.write(ctx, marshal(outFrame{T: TReady, SID: s.conn.SID})); err != nil {
		return err
	}
	return s.readLoop(ctx)
}

func (s *session) write(ctx context.Context, b []byte) error {
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return s.ws.Write(wctx, websocket.MessageText, b)
}

// fail ends the session once: the error frame, then the close with its status.
func (s *session) fail(code string, status websocket.StatusCode) {
	s.failOnce.Do(func() {
		s.failed.Store(true)
		s.sendError(context.Background(), code, nil)
		_ = s.ws.Close(status, code)
		s.cancel(&closeError{code, status})
	})
}

// writer sends what the hub queued: control frames at once, positions at most
// every MoveFlushEvery with only the latest of each sender.
func (s *session) writer(ctx context.Context) {
	out := s.conn.out
	var lastMoves time.Time
	var timer *time.Timer
	for {
		select {
		case <-ctx.Done():
			return
		case <-out.signal:
		}
		for {
			frames, overflow := out.takeControl()
			if overflow {
				s.fail(CodeSlow, websocket.StatusPolicyViolation)
				return
			}
			for _, f := range frames {
				if err := s.write(ctx, f); err != nil {
					s.cancel(err)
					return
				}
			}
			if !out.hasMoves() {
				break
			}
			wait := MoveFlushEvery - time.Since(lastMoves)
			if wait > 0 {
				if timer == nil {
					timer = time.NewTimer(wait)
				} else {
					timer.Reset(wait)
				}
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			for _, f := range out.takeMoves() {
				if err := s.write(ctx, f); err != nil {
					s.cancel(err)
					return
				}
			}
			lastMoves = time.Now()
		}
	}
}

// pinger keeps the connection alive through proxies and detects a dead peer.
func (s *session) pinger(ctx context.Context) {
	t := time.NewTicker(s.h.opts.PingEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pctx, cancel := context.WithTimeout(ctx, PingTimeout)
		err := s.ws.Ping(pctx)
		cancel()
		if err != nil {
			s.cancel(err)
			return
		}
	}
}

// expiry ends the session when its token expires; the client renews it with a
// new auth frame before.
func (s *session) expiry(ctx context.Context) {
	for {
		s.mu.Lock()
		exp := s.exp
		s.mu.Unlock()
		wait := time.Until(exp)
		if exp.IsZero() {
			wait = time.Hour
		}
		if wait <= 0 {
			s.fail(CodeTokenExpired, closeUnauthenticated)
			return
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// watch reacts to the events of the user and rechecks periodically: a share
// that changed, a suspension, a profile that switched presence off, and, as a
// net under lost events, every RecheckEvery.
func (s *session) watch(sub *notify.Sub) func(context.Context) {
	return func(ctx context.Context) {
		events := make(chan []notify.Event)
		go func() {
			defer close(events)
			for {
				batch, err := sub.Next(ctx)
				if err != nil {
					return
				}
				select {
				case events <- batch:
				case <-ctx.Done():
					return
				}
			}
		}()
		t := time.NewTicker(s.h.opts.RecheckEvery)
		defer t.Stop()
		// A commit may move a file out of the scope of a folder share without any
		// share event: the vault events of the rooms' vaults trigger a recheck of
		// those rooms, at most every VaultRecheckEvery.
		vt := time.NewTicker(s.h.opts.VaultRecheckEvery)
		defer vt.Stop()
		pending := map[uuid.UUID]bool{}
		for {
			recheckRooms, recheckAccount := false, false
			select {
			case <-ctx.Done():
				return
			case <-vt.C:
				if len(pending) > 0 {
					s.recheckRooms(ctx, pending)
					pending = map[uuid.UUID]bool{}
				}
				continue
			case <-t.C:
				recheckRooms, recheckAccount = true, true
			case batch, ok := <-events:
				if !ok {
					return
				}
				for _, ev := range batch {
					switch ev.Kind {
					case notify.KindShare:
						recheckRooms = true
					case notify.KindAccount:
						recheckAccount = true
						if ev.AccountKind == notify.AccountSuspended {
							s.fail(CodeSuspended, closeForbidden)
							return
						}
					case notify.KindConfig:
						recheckAccount = true
					case notify.KindVault:
						pending[ev.VaultID] = true
					}
				}
			}
			if recheckAccount && !s.recheckAccount(ctx) {
				return
			}
			if recheckRooms {
				s.recheckRooms(ctx, nil)
			}
		}
	}
}

// recheckAccount reports whether the session may go on.
func (s *session) recheckAccount(ctx context.Context) bool {
	s.mu.Lock()
	token := s.token
	s.mu.Unlock()
	// The token is the one of the last auth frame; the verifier's cache makes
	// this one status lookup per 30 s at most.
	if _, _, err := s.h.env.Authenticate(ctx, token); err != nil {
		switch {
		case errors.Is(err, auth.ErrSuspended):
			s.fail(CodeSuspended, closeForbidden)
			return false
		case errors.Is(err, auth.ErrInvalidToken):
			s.fail(CodeTokenExpired, closeUnauthenticated)
			return false
		}
		return ctx.Err() == nil // a transient failure: keep going, the next check retries
	}
	on, err := s.h.env.Enabled(ctx, s.conn.User)
	if err == nil && !on {
		s.fail(CodeDisabled, closeForbidden)
		return false
	}
	return true
}

// recheckRooms throws the connection out of the rooms the user may no longer read.
func (s *session) recheckRooms(ctx context.Context, vaults map[uuid.UUID]bool) {
	for _, room := range s.h.hub.Rooms(s.conn) {
		if vaults != nil && !vaults[room.Vault] {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := s.h.env.CanView(cctx, s.conn.User, room)
		cancel()
		if err == nil || ctx.Err() != nil || (!errors.Is(err, ErrNotFound) && !errors.Is(err, ErrEncrypted)) {
			continue // fine, or a transient failure the next round retries
		}
		s.h.hub.Leave(s.conn, room)
		s.conn.out.forget(room)
		s.conn.out.control(marshal(outFrame{T: TError, Code: CodeForbidden, Room: &room}))
	}
}

func (s *session) readLoop(ctx context.Context) error {
	for {
		f, n, err := readFrame(ctx, s.ws)
		if err != nil {
			return err
		}
		if f.T != TAuth && n > MaxFrameBytes {
			return &closeError{CodeTooLarge, websocket.StatusMessageTooBig}
		}
		switch f.T {
		case TAuth:
			p, exp, err := s.authenticate(ctx, f)
			if err != nil {
				return err
			}
			if p.UserID != s.conn.User {
				return &closeError{CodeUnauth, closeUnauthenticated}
			}
			s.mu.Lock()
			s.token, s.exp = f.Token, exp
			s.mu.Unlock()
		case TPing:
			s.conn.out.control(marshal(outFrame{T: TPong}))
		case TJoin:
			s.join(ctx, f)
		case TLeave:
			if f.Room == nil {
				s.reject(CodeBadFrame, nil)
				continue
			}
			s.h.hub.Leave(s.conn, *f.Room)
			s.conn.out.forget(*f.Room)
		case TMove:
			s.move(f)
		default:
			s.reject(CodeBadFrame, f.Room)
		}
	}
}

func (s *session) reject(code string, room *Room) {
	s.conn.out.control(marshal(outFrame{T: TError, Code: code, Room: room}))
}

func (s *session) join(ctx context.Context, f inFrame) {
	if f.Room == nil || f.Room.Vault == uuid.Nil || f.Room.File == uuid.Nil {
		s.reject(CodeBadFrame, f.Room)
		return
	}
	room := *f.Room
	if list, ok := s.h.hub.Members(s.conn, room); ok {
		s.conn.out.control(marshal(outFrame{T: TMembers, Room: &room, List: list}))
		return
	}
	{
		if s.h.hub.RoomCount(s.conn) >= MaxRoomsPerConn {
			s.reject(CodeTooManyRooms, &room)
			return
		}
		if !s.joins.Allow() {
			s.reject(CodeTooManyConns, &room)
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := s.h.env.CanView(cctx, s.conn.User, room)
		cancel()
		switch {
		case err == nil:
		case errors.Is(err, ErrEncrypted):
			s.reject(CodeEncrypted, &room)
			return
		case errors.Is(err, ErrNotFound):
			s.reject(CodeNotFound, &room)
			return
		default:
			s.log.Error().Err(err).Msg("presence: authorization failed")
			s.reject(CodeInternal, &room)
			return
		}
	}
	list := s.h.hub.Join(s.conn, room)
	s.conn.out.control(marshal(outFrame{T: TMembers, Room: &room, List: list}))
}

// move relays a position. Beyond MaxMovesPerSecond the latest position of a
// room is held and sent when the budget allows: the others never see a stale
// pointer for long, and a flood costs one timer.
func (s *session) move(f inFrame) {
	if f.Room == nil || len(f.Pos) == 0 || string(f.Pos) == "null" {
		s.reject(CodeBadFrame, f.Room)
		return
	}
	if len(f.Pos) > MaxPosBytes {
		s.reject(CodeTooLarge, f.Room)
		return
	}
	room := *f.Room
	if !s.h.hub.In(s.conn, room) {
		s.reject(CodeNotJoined, &room)
		return
	}
	if s.moves.Allow() {
		s.h.hub.Move(s.conn, room, f.Pos)
		return
	}
	s.heldMu.Lock()
	s.held[room] = f.Pos
	if !s.heldSet {
		s.heldSet = true
		time.AfterFunc(2*time.Second/MaxMovesPerSecond, s.flushHeld)
	}
	s.heldMu.Unlock()
}

func (s *session) flushHeld() {
	s.heldMu.Lock()
	defer s.heldMu.Unlock()
	if s.conn.out.isClosed() {
		s.held = map[Room]json.RawMessage{}
		s.heldSet = false
		return
	}
	for room, pos := range s.held {
		if !s.moves.Allow() {
			break
		}
		delete(s.held, room)
		s.h.hub.Move(s.conn, room, pos)
	}
	if len(s.held) == 0 {
		s.heldSet = false
		return
	}
	time.AfterFunc(2*time.Second/MaxMovesPerSecond, s.flushHeld)
}
