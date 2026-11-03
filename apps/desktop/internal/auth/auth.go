// Package auth signs the desktop in to the cloud with OpenID Connect
// Authorization Code + PKCE in the system browser (§1.3, RFC 8252). The
// redirect is a loopback listener on a random port, with the custom scheme
// memobrain://auth/callback as fallback (D-08). The refresh token lives in the OS
// keychain; the access token only in memory. The browser build (ADR-0030) leaves the
// flow and the keychain out (oidc_native.go, keychain_native.go): its page owns the
// session (Hosted, hosted.go).
package auth

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/apiclient"
)

// Status of the session.
type Status string

// Session statuses (event auth:state).
const (
	StatusSignedOut    Status = "signed_out"
	StatusSigningIn    Status = "signing_in"
	StatusReady        Status = "ready"
	StatusDisconnected Status = "disconnected" // credentials exist but the server is unreachable or the token could not be refreshed yet
	// StatusDeviceRevoked: signed in, but the cloud refuses this device (revoked from the device
	// list). Nothing syncs, local data and pending changes are kept; ReregisterDevice resumes.
	StatusDeviceRevoked Status = "device_revoked"
)

// DeviceRevokedMessage is State.Error while the device is revoked.
const DeviceRevokedMessage = "this device was revoked from your account: register it again to resume synchronization"

// RedirectMode selects how the authorization code comes back (D-08).
type RedirectMode string

// Redirect modes.
const (
	RedirectAuto     RedirectMode = "auto"
	RedirectLoopback RedirectMode = "loopback"
	RedirectScheme   RedirectMode = "scheme"
)

// ParseRedirectMode reads a mode as written in the Config Profile
// (auth.redirect_mode: auto, loopback, custom_scheme) or in the environment
// ("scheme" is accepted as well). Anything else, empty included, is "".
func ParseRedirectMode(v string) RedirectMode {
	switch v {
	case "auto":
		return RedirectAuto
	case "loopback":
		return RedirectLoopback
	case "custom_scheme", "scheme":
		return RedirectScheme
	}
	return ""
}

// SchemeRedirectURI is the custom-scheme callback registered in Keycloak.
const SchemeRedirectURI = "memobrain://auth/callback"

// Profile is the signed-in user as seen by the client.
type Profile struct {
	UserID      string `json:"userId"`
	Username    string `json:"username"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
}

// State is what the UI shows.
type State struct {
	Status    Status  `json:"status"`
	ServerURL string  `json:"serverUrl"`
	Profile   Profile `json:"profile"`
	DeviceID  string  `json:"deviceId"`
	Error     string  `json:"error"`
}

// Options configure the service.
type Options struct {
	DataDir string
	Logger  zerolog.Logger
	// OpenURL opens the system browser (runtime.BrowserOpenURL in the app).
	OpenURL func(url string) error
	// OnState is called on every status change.
	OnState func(State)
	// RedirectMode, when set, overrides the mode distributed by the Config
	// Profile (SetManagedRedirectMode); both unset means auto.
	RedirectMode RedirectMode
	// HTTPClient is used for discovery, token and API calls (nil = default).
	HTTPClient *http.Client
	// Secrets stores the refresh token (nil = OS keychain).
	Secrets SecretStore
	// Device description sent at registration.
	DeviceName string
	Platform   string
	AppVersion string
	// LoginTimeout bounds how long the browser flow may take (default 5 min).
	LoginTimeout time.Duration
	// Hosted makes the page that runs the core the owner of the session (browser build, ADR-0029).
	Hosted *Hosted
}

// Hosted describes a session owned by the host page. The page already signed in with OIDC, so there
// is no browser flow, no refresh token and no keychain: the core asks the page for an access token
// whenever it needs one.
type Hosted struct {
	// ServerURL is the cloud this session talks to (the origin that served the page).
	ServerURL string
	// Token returns a valid access token, renewed by the page when needed.
	Token func(ctx context.Context) (string, error)
}

// Service is the session manager.
type Service struct {
	opts    Options
	logger  zerolog.Logger
	secrets SecretStore
	hc      *http.Client
	// keychainRetry is defaultKeychainRetry (shorter in tests).
	keychainRetry time.Duration

	// refreshMu serializes token refreshes: the refresh token rotates, so two concurrent
	// refreshes with the same token make the second one fail (reuse detection) and sign out.
	refreshMu sync.Mutex

	mu      sync.Mutex
	state   State
	session *persisted
	// idp is the identity provider of a desktop session (nil until discovery; always nil in the
	// browser build).
	idp     *idpClient
	access  string
	expiry  time.Time
	refresh string
	// refreshUnsaved marks a rotated refresh token the keychain refused.
	refreshUnsaved bool
	// keychainTried is when the keychain was last read for a session
	// restored without its refresh token (zero: not pending).
	keychainTried time.Time
	pending       *attempt
	// rejected is the session whose tokens the cloud keeps refusing
	// (SessionExpired): it stays disconnected until a new sign-in.
	rejected *persisted
	// managedMode is the redirect mode of the Config Profile ("" = none).
	managedMode RedirectMode
}

type attempt struct {
	state       string
	verifier    string
	redirectURI string
	result      chan url.Values
	listener    net.Listener
}

// New creates the service; call Restore to resume a previous session.
func New(opts Options) *Service {
	if opts.LoginTimeout == 0 {
		opts.LoginTimeout = 5 * time.Minute
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	if opts.Secrets == nil {
		if opts.Hosted != nil {
			opts.Secrets = NewMemoryStore() // nothing secret is kept: the page owns the tokens
		} else {
			opts.Secrets = defaultSecrets()
		}
	}
	if opts.OnState == nil {
		opts.OnState = func(State) {}
	}
	if opts.DeviceName == "" {
		if h, err := os.Hostname(); err == nil {
			opts.DeviceName = h
		} else {
			opts.DeviceName = "MemoBrain Notes desktop"
		}
	}
	if opts.Platform == "" {
		opts.Platform = platformName()
	}
	return &Service{opts: opts, logger: opts.Logger, secrets: opts.Secrets, hc: opts.HTTPClient, state: State{Status: StatusSignedOut}, keychainRetry: defaultKeychainRetry}
}

func platformName() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	case "js":
		return "web"
	default:
		return "linux"
	}
}

// State returns the current session state.
func (s *Service) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *Service) setState(mutate func(*State)) {
	s.mu.Lock()
	mutate(&s.state)
	st := s.state
	s.mu.Unlock()
	s.opts.OnState(st)
}

// SetManagedRedirectMode applies auth.redirect_mode from the Config Profile
// ("" clears it). An explicit Options.RedirectMode still takes precedence.
func (s *Service) SetManagedRedirectMode(m RedirectMode) {
	s.mu.Lock()
	s.managedMode = m
	s.mu.Unlock()
}

// redirectMode is the mode of the next login: the explicit option, else the
// Config Profile, else auto.
func (s *Service) redirectMode() RedirectMode {
	if s.opts.RedirectMode != "" {
		return s.opts.RedirectMode
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.managedMode != "" {
		return s.managedMode
	}
	return RedirectAuto
}

// GRPCEndpoint is the host:port of the notification stream announced by the server.
func (s *Service) GRPCEndpoint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session == nil {
		return ""
	}
	return s.session.GRPCEndpoint
}

// DeviceName is the name this device registered with.
func (s *Service) DeviceName() string { return s.opts.DeviceName }

// Client returns an API client for the signed-in server, or nil when signed out.
func (s *Service) Client() *transport.Client {
	s.mu.Lock()
	sess := s.session
	s.mu.Unlock()
	if sess == nil {
		return nil
	}
	c, err := transport.New(sess.ServerURL, s, s.hc, "memobrain-desktop/"+s.opts.AppVersion)
	if err != nil {
		return nil
	}
	return c
}

// Login runs the browser flow against serverURL and, on success, loads the
// profile and registers the device. It blocks until the flow completes.
// serverURL, and the issuer it announces, must be https or http on this
// computer (transport.CheckSecureURL): the error then wraps
// transport.ErrInsecureURL.
func (s *Service) Login(ctx context.Context, serverURL string) error {
	if s.opts.Hosted != nil {
		return s.hostedLogin(ctx)
	}
	if err := transport.CheckSecureURL(serverURL); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, s.opts.LoginTimeout)
	defer cancel()

	s.mu.Lock()
	if s.pending != nil {
		s.mu.Unlock()
		return errors.New("a login is already in progress")
	}
	s.mu.Unlock()

	s.setState(func(st *State) { st.Status = StatusSigningIn; st.ServerURL = serverURL; st.Error = "" })
	err := s.login(ctx, serverURL)
	if err != nil {
		s.logger.Warn().Err(err).Msg("login failed")
		s.setState(func(st *State) {
			if s.session == nil {
				st.Status = StatusSignedOut
			} else {
				st.Status = StatusDisconnected
			}
			st.Error = err.Error()
		})
	}
	return err
}

// completeSession loads the profile, registers the device if needed and
// persists the session, then goes to ready.
func (s *Service) completeSession(ctx context.Context) error {
	client := s.Client()
	if client == nil {
		// Signed out meanwhile (e.g. the refresh token was rejected by a concurrent call).
		return errors.New("not signed in")
	}
	me, err := client.GetMe(ctx)
	if err != nil {
		return fmt.Errorf("profile: %w", err)
	}
	s.mu.Lock()
	sess := s.session
	s.mu.Unlock()
	if sess == nil {
		return errors.New("not signed in")
	}
	if sess.Profile.UserID != "" && sess.Profile.UserID != me.Id.String() {
		sess.DeviceID = "" // the registered device belongs to the previous account
	}
	s.mu.Lock()
	if sess.DeviceID == "" {
		sess.DeviceRevoked = false // a new registration follows
	}
	s.mu.Unlock()
	if sess.DeviceID == "" {
		reg := transport.DeviceRegistration{Name: s.opts.DeviceName, Platform: apiclient.DeviceRegistrationPlatform(s.opts.Platform)}
		if s.opts.AppVersion != "" {
			reg.AppVersion = &s.opts.AppVersion
		}
		dev, err := client.RegisterDevice(ctx, reg)
		if err != nil {
			return fmt.Errorf("register device: %w", err)
		}
		sess.DeviceID = dev.Id.String()
	}
	sess.Profile = Profile{UserID: me.Id.String(), Username: me.Username, Email: string(me.Email), Role: string(me.Role)}
	if me.DisplayName != nil {
		sess.Profile.DisplayName = *me.DisplayName
	}
	if err := saveSession(s.opts.DataDir, sess); err != nil {
		return err
	}
	s.setState(func(st *State) {
		st.Status, st.ServerURL, st.Profile, st.DeviceID, st.Error = StatusReady, sess.ServerURL, sess.Profile, sess.DeviceID, ""
		if sess.DeviceRevoked {
			st.Status, st.Error = StatusDeviceRevoked, DeviceRevokedMessage
		}
	})
	return nil
}

// revokedLocked reports whether the session's device is revoked (s.mu held).
func (s *Service) revokedLocked() bool { return s.session != nil && s.session.DeviceRevoked }

// setDisconnected shows a failure to reach the server or renew the token. A
// revoked device keeps showing the revocation: that is what the user must act on.
func (s *Service) setDisconnected(err error) {
	s.setState(func(st *State) {
		if s.revokedLocked() {
			return
		}
		st.Status, st.Error = StatusDisconnected, err.Error()
	})
}

// DeviceRevoked records that the cloud refused the device id as revoked (from the console or
// from another device). The account stays signed in and keeps its tokens; the state becomes
// device_revoked, persisted so a restart does not try to sync with the dead id, until
// ReregisterDevice registers a new device. id is the device the refusal was about: a late
// report about a device already replaced is ignored ("" means the current one).
func (s *Service) DeviceRevoked(id string) {
	s.mu.Lock()
	sess := s.session
	if sess == nil || sess.DeviceRevoked || sess.DeviceID == "" || id != "" && sess.DeviceID != id {
		s.mu.Unlock()
		return
	}
	sess.DeviceRevoked = true
	snapshot := *sess
	s.mu.Unlock()
	s.logger.Warn().Str("device", snapshot.DeviceID).Msg("the cloud refuses this device as revoked; synchronization stops")
	if err := saveSession(s.opts.DataDir, &snapshot); err != nil {
		s.logger.Warn().Err(err).Msg("could not persist the revoked device")
	}
	s.setState(func(st *State) { st.Status, st.Error = StatusDeviceRevoked, DeviceRevokedMessage })
}

// ReregisterDevice replaces a revoked device with a new registration ("Register this device
// again"): the same account, a new device id, then ready, so synchronization resumes and pushes
// what waited meanwhile. The token is renewed silently; when the account itself was signed out
// (refresh token refused) the session ends and the user signs in again, which registers a new
// device as well. On any other failure the device stays revoked.
func (s *Service) ReregisterDevice(ctx context.Context) error {
	s.mu.Lock()
	sess := s.session
	if sess == nil {
		s.mu.Unlock()
		return errNotSignedIn
	}
	oldID, oldRevoked := sess.DeviceID, sess.DeviceRevoked
	sess.DeviceID, sess.DeviceRevoked = "", false
	s.mu.Unlock()
	var err error
	if s.opts.Hosted != nil {
		err = s.hostedLogin(ctx)
	} else {
		s.setState(func(st *State) { st.Status = StatusSigningIn; st.Error = "" })
		err = s.completeSession(ctx)
	}
	if err == nil {
		return nil
	}
	s.logger.Warn().Err(err).Msg("register the device again")
	s.mu.Lock()
	current := s.session == sess
	if current && sess.DeviceID == "" {
		sess.DeviceID, sess.DeviceRevoked = oldID, oldRevoked
	}
	s.mu.Unlock()
	if current {
		s.setState(func(st *State) {
			st.Status, st.DeviceID, st.Error = StatusDisconnected, oldID, err.Error()
			if oldRevoked {
				st.Status, st.Error = StatusDeviceRevoked, DeviceRevokedMessage+" ("+err.Error()+")"
			}
		})
	}
	return err
}

// HandleCallback delivers a memobrain://auth/callback (custom scheme fallback).
func (s *Service) HandleCallback(params url.Values) bool {
	s.mu.Lock()
	att := s.pending
	s.mu.Unlock()
	if att == nil {
		return false
	}
	select {
	case att.result <- params:
		return true
	default:
		return false
	}
}

// Token implements transport.TokenSource: returns a valid access token,
// refreshing it (with rotation) when it is about to expire.
func (s *Service) Token(ctx context.Context) (string, error) {
	if s.opts.Hosted != nil {
		return s.hostedToken(ctx)
	}
	s.mu.Lock()
	if s.session == nil {
		s.mu.Unlock()
		return "", errors.New("not signed in")
	}
	if s.access != "" && time.Until(s.expiry) > 30*time.Second {
		tok := s.access
		s.mu.Unlock()
		return tok, nil
	}
	s.mu.Unlock()
	return s.refreshToken(ctx)
}

// reconnected turns a disconnected session ready again once a token was
// obtained, unless the cloud refuses the tokens of this session
// (SessionExpired): a new token from the identity provider does not change
// that, and each change of state restarts the notification stream.
func (s *Service) reconnected() {
	s.mu.Lock()
	rejected := s.session != nil && s.rejected == s.session
	s.mu.Unlock()
	if !rejected && s.State().Status == StatusDisconnected {
		s.setState(func(st *State) { st.Status = StatusReady; st.Error = "" })
	}
}

var (
	_ transport.TokenInvalidator = (*Service)(nil)
	_ transport.SessionReporter  = (*Service)(nil)
)

// InvalidateToken implements transport.TokenInvalidator: the cloud refused
// tok (HTTP 401) although it has not expired here (clock skew, a key
// rotation on the identity provider). The next Token call refreshes it
// instead of returning it again. A hosted session has no token of its own
// to drop: the host page renews it.
func (s *Service) InvalidateToken(tok string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if tok != "" && s.access == tok {
		s.access, s.expiry = "", time.Time{}
	}
}

// SessionExpired implements transport.SessionReporter: the cloud keeps
// refusing the tokens of this session, fresh ones included (an account
// deleted or suspended, a server that no longer trusts this identity
// provider). The session is shown disconnected with err, and stays so until
// the user signs in again; the notification stream has stopped. Repeated
// reports change nothing, so they do not restart the stream either.
func (s *Service) SessionExpired(err error) {
	s.mu.Lock()
	sess := s.session
	if sess == nil || s.rejected == sess {
		s.mu.Unlock()
		return
	}
	s.rejected = sess
	s.mu.Unlock()
	s.logger.Warn().Err(err).Msg("the cloud refuses this session's tokens")
	s.setDisconnected(err)
}

// defaultKeychainRetry spaces the keychain reads of a session restored while
// the keychain was unavailable (a dismissed prompt must not come back on
// every call).
const defaultKeychainRetry = 30 * time.Second

var errNotSignedIn = errors.New("not signed in")

var errKeychainUnavailable = errors.New("the system keychain is not available: sign-in will be retried")

// Restore resumes a persisted session: the profile is shown immediately as
// "disconnected" and a background refresh turns it into "ready".
func (s *Service) Restore(ctx context.Context) {
	if s.opts.Hosted != nil {
		s.restoreHosted(ctx)
		return
	}
	sess, err := loadSession(s.opts.DataDir)
	if err != nil || sess == nil {
		if err != nil {
			s.logger.Warn().Err(err).Msg("auth session unreadable; ignoring")
		}
		return
	}
	// A session saved before plain http to another computer was refused is
	// not resumed: the user signs in again over https.
	if err := errors.Join(transport.CheckSecureURL(sess.ServerURL), transport.CheckSecureURL(sess.Issuer)); err != nil {
		s.logger.Warn().Err(err).Msg("saved session uses an insecure url; not resumed")
		s.setState(func(st *State) { *st = State{Status: StatusSignedOut, Error: err.Error()} })
		return
	}
	refresh, err := s.secrets.Get(sess.ServerURL)
	if err == nil && refresh == "" {
		s.logger.Info().Msg("no refresh token in keychain; signed out")
		_ = deleteSession(s.opts.DataDir)
		return
	}
	// A keychain that cannot be read yet (Secret Service still locked at
	// login, a dismissed prompt) keeps the session and its device
	// registration: Token reads the keychain again later.
	errText := ""
	if err != nil {
		s.logger.Warn().Err(err).Msg("keychain unavailable at startup; session kept")
		errText = errKeychainUnavailable.Error()
	}
	s.mu.Lock()
	s.session, s.refresh, s.keychainTried = sess, refresh, time.Time{}
	if err != nil {
		s.keychainTried = time.Now()
	}
	s.mu.Unlock()
	s.setState(func(st *State) {
		st.Status, st.ServerURL, st.Profile, st.DeviceID, st.Error = StatusDisconnected, sess.ServerURL, sess.Profile, sess.DeviceID, errText
		if sess.DeviceRevoked {
			st.Status, st.Error = StatusDeviceRevoked, DeviceRevokedMessage
		}
	})
	go func() {
		for {
			rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
			_, err := s.Token(rctx)
			if err == nil {
				if err := s.completeSession(rctx); err != nil {
					s.logger.Warn().Err(err).Msg("session refresh")
				}
			}
			cancel()
			if !errors.Is(err, errKeychainUnavailable) {
				return
			}
			// The keychain may unlock later (Secret Service after login).
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.keychainRetry):
			}
		}
	}()
}

// Logout revokes the refresh token (best effort), clears the keychain and
// the persisted session.
func (s *Service) Logout(ctx context.Context) error {
	s.mu.Lock()
	sess, refresh, idp := s.session, s.refresh, s.idp
	s.mu.Unlock()
	if sess == nil {
		return nil
	}
	if idp != nil && refresh != "" && s.opts.Hosted == nil {
		s.revokeRefresh(ctx, sess, idp, refresh)
	}
	s.clearSession()
	return nil
}

func (s *Service) clearSession() {
	s.mu.Lock()
	server := ""
	if s.session != nil {
		server = s.session.ServerURL
	}
	s.session, s.idp = nil, nil
	s.access, s.refresh, s.expiry = "", "", time.Time{}
	s.refreshUnsaved, s.keychainTried, s.rejected = false, time.Time{}, nil
	s.mu.Unlock()
	if server != "" {
		_ = s.secrets.Delete(server)
	}
	if s.opts.Hosted == nil { // a hosted session keeps its device registration across sign-ins
		_ = deleteSession(s.opts.DataDir)
	}
	s.setState(func(st *State) { *st = State{Status: StatusSignedOut} })
}
