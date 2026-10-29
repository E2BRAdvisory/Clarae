// Package auth signs the desktop in to the cloud with OpenID Connect
// Authorization Code + PKCE in the system browser (§1.3, RFC 8252). The
// redirect is a loopback listener on a random port, with the custom scheme
// memobrain://auth/callback as fallback (D-08). The refresh token lives in the OS
// keychain; the access token only in memory.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/rs/zerolog"
	"golang.org/x/oauth2"

	"memobrain/apps/desktop/internal/sync/transport"
)

// Status of the session.
type Status string

// Session statuses (event auth:state).
const (
	StatusSignedOut    Status = "signed_out"
	StatusSigningIn    Status = "signing_in"
	StatusReady        Status = "ready"
	StatusDisconnected Status = "disconnected" // credentials exist but the server is unreachable or the token could not be refreshed yet
)

// RedirectMode selects how the authorization code comes back (D-08).
type RedirectMode string

// Redirect modes.
const (
	RedirectAuto     RedirectMode = "auto"
	RedirectLoopback RedirectMode = "loopback"
	RedirectScheme   RedirectMode = "scheme"
)

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
	// RedirectMode defaults to auto.
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

	// refreshMu serializes token refreshes: the refresh token rotates, so two concurrent
	// refreshes with the same token make the second one fail (reuse detection) and sign out.
	refreshMu sync.Mutex

	mu       sync.Mutex
	state    State
	session  *persisted
	oauth    *oauth2.Config
	provider *oidc.Provider
	access   string
	expiry   time.Time
	refresh  string
	pending  *attempt
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
	if opts.RedirectMode == "" {
		opts.RedirectMode = RedirectAuto
	}
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
			opts.Secrets = KeychainStore{}
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
	return &Service{opts: opts, logger: opts.Logger, secrets: opts.Secrets, hc: opts.HTTPClient, state: State{Status: StatusSignedOut}}
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
func (s *Service) Login(ctx context.Context, serverURL string) error {
	if s.opts.Hosted != nil {
		return s.hostedLogin(ctx)
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

func (s *Service) login(ctx context.Context, serverURL string) error {
	client, err := transport.New(serverURL, nil, s.hc, "memobrain-desktop/"+s.opts.AppVersion)
	if err != nil {
		return err
	}
	cc, err := client.GetClientConfig(ctx)
	if err != nil {
		return fmt.Errorf("server configuration: %w", err)
	}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, s.hc), cc.Issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	cfg := &oauth2.Config{
		ClientID: cc.DesktopClientID,
		Endpoint: provider.Endpoint(),
		Scopes:   []string{oidc.ScopeOpenID, "profile", "email", oidc.ScopeOfflineAccess},
	}

	att := &attempt{state: randomString(24), verifier: oauth2.GenerateVerifier(), result: make(chan url.Values, 1)}
	if s.opts.RedirectMode != RedirectScheme {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		switch {
		case err == nil:
			att.listener = ln
			att.redirectURI = fmt.Sprintf("http://127.0.0.1:%d/cb", ln.Addr().(*net.TCPAddr).Port)
		case s.opts.RedirectMode == RedirectLoopback:
			return fmt.Errorf("loopback listener: %w", err)
		default:
			s.logger.Warn().Err(err).Msg("loopback listener unavailable, falling back to custom scheme")
		}
	}
	if att.redirectURI == "" {
		att.redirectURI = SchemeRedirectURI
	}
	cfg.RedirectURL = att.redirectURI

	s.mu.Lock()
	s.pending = att
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.pending = nil
		s.mu.Unlock()
		if att.listener != nil {
			_ = att.listener.Close()
		}
	}()

	if att.listener != nil {
		go s.serveLoopback(att)
	}
	authURL := cfg.AuthCodeURL(att.state, oauth2.AccessTypeOffline, oauth2.S256ChallengeOption(att.verifier))
	if err := s.opts.OpenURL(authURL); err != nil {
		return fmt.Errorf("open browser: %w", err)
	}

	var params url.Values
	select {
	case params = <-att.result:
	case <-ctx.Done():
		return fmt.Errorf("login timed out or was cancelled: %w", ctx.Err())
	}
	if e := params.Get("error"); e != "" {
		return fmt.Errorf("authorization refused: %s %s", e, params.Get("error_description"))
	}
	if params.Get("state") != att.state {
		return errors.New("state mismatch in callback")
	}
	code := params.Get("code")
	if code == "" {
		return errors.New("callback without code")
	}
	tok, err := cfg.Exchange(oidc.ClientContext(ctx, s.hc), code, oauth2.VerifierOption(att.verifier))
	if err != nil {
		return fmt.Errorf("token exchange: %w", err)
	}
	if tok.RefreshToken == "" {
		return errors.New("no refresh token issued (offline_access scope missing?)")
	}

	s.mu.Lock()
	s.provider, s.oauth = provider, cfg
	s.access, s.expiry, s.refresh = tok.AccessToken, tok.Expiry, tok.RefreshToken
	s.session = &persisted{ServerURL: serverURL, Issuer: cc.Issuer, ClientID: cc.DesktopClientID, Audience: cc.Audience, GRPCEndpoint: cc.GRPCEndpoint}
	s.mu.Unlock()

	if err := s.secrets.Set(serverURL, tok.RefreshToken); err != nil {
		return fmt.Errorf("store refresh token: %w", err)
	}
	return s.completeSession(ctx)
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
	if sess.Profile.UserID != "" && sess.Profile.UserID != me.ID {
		sess.DeviceID = "" // the registered device belongs to the previous account
	}
	if sess.DeviceID == "" {
		dev, err := client.RegisterDevice(ctx, transport.DeviceRegistration{Name: s.opts.DeviceName, Platform: s.opts.Platform, AppVersion: s.opts.AppVersion})
		if err != nil {
			return fmt.Errorf("register device: %w", err)
		}
		sess.DeviceID = dev.ID
	}
	sess.Profile = Profile{UserID: me.ID, Username: me.Username, Email: me.Email, Role: me.Role}
	if me.DisplayName != nil {
		sess.Profile.DisplayName = *me.DisplayName
	}
	if err := saveSession(s.opts.DataDir, sess); err != nil {
		return err
	}
	s.setState(func(st *State) {
		st.Status, st.ServerURL, st.Profile, st.DeviceID, st.Error = StatusReady, sess.ServerURL, sess.Profile, sess.DeviceID, ""
	})
	return nil
}

func (s *Service) serveLoopback(att *attempt) {
	mux := http.NewServeMux()
	mux.HandleFunc("/cb", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, loopbackPage)
		select {
		case att.result <- r.URL.Query():
		default:
		}
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	_ = srv.Serve(att.listener)
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

	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	// Another caller may have refreshed (and rotated the token) while this one waited.
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
	if err := s.ensureOAuthLocked(ctx); err != nil {
		s.mu.Unlock()
		s.setState(func(st *State) { st.Status = StatusDisconnected; st.Error = err.Error() })
		return "", err
	}
	cfg, refresh := s.oauth, s.refresh
	s.mu.Unlock()

	tok, err := cfg.TokenSource(oidc.ClientContext(ctx, s.hc), &oauth2.Token{RefreshToken: refresh}).Token()
	if err != nil {
		var re *oauth2.RetrieveError
		if errors.As(err, &re) && (re.ErrorCode == "invalid_grant" || re.Response != nil && re.Response.StatusCode == http.StatusBadRequest) {
			// Refresh token revoked (user suspended, session revoked, rotation reuse): sign out.
			s.logger.Warn().Err(err).Msg("refresh token rejected; signing out")
			s.clearSession()
			return "", fmt.Errorf("session revoked: %w", err)
		}
		s.setState(func(st *State) { st.Status = StatusDisconnected; st.Error = err.Error() })
		return "", err
	}
	s.mu.Lock()
	s.access, s.expiry = tok.AccessToken, tok.Expiry
	server := s.session.ServerURL
	rotated := tok.RefreshToken != "" && tok.RefreshToken != s.refresh
	if rotated {
		s.refresh = tok.RefreshToken
	}
	s.mu.Unlock()
	if rotated {
		if err := s.secrets.Set(server, tok.RefreshToken); err != nil {
			s.logger.Error().Err(err).Msg("store rotated refresh token")
		}
	}
	if s.State().Status == StatusDisconnected {
		s.setState(func(st *State) { st.Status = StatusReady; st.Error = "" })
	}
	return tok.AccessToken, nil
}

// ensureOAuthLocked performs discovery lazily after a Restore (the issuer may
// have been unreachable at startup). Caller holds s.mu.
func (s *Service) ensureOAuthLocked(ctx context.Context) error {
	if s.oauth != nil {
		return nil
	}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, s.hc), s.session.Issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	s.provider = provider
	s.oauth = &oauth2.Config{ClientID: s.session.ClientID, Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID, "profile", "email", oidc.ScopeOfflineAccess}}
	return nil
}

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
	refresh, err := s.secrets.Get(sess.ServerURL)
	if err != nil || refresh == "" {
		s.logger.Info().Msg("no refresh token in keychain; signed out")
		_ = deleteSession(s.opts.DataDir)
		return
	}
	s.mu.Lock()
	s.session, s.refresh = sess, refresh
	s.mu.Unlock()
	s.setState(func(st *State) {
		st.Status, st.ServerURL, st.Profile, st.DeviceID = StatusDisconnected, sess.ServerURL, sess.Profile, sess.DeviceID
	})
	go func() {
		rctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		if _, err := s.Token(rctx); err == nil {
			if err := s.completeSession(rctx); err != nil {
				s.logger.Warn().Err(err).Msg("session refresh")
			}
		}
	}()
}

// Logout revokes the refresh token (best effort), clears the keychain and
// the persisted session.
func (s *Service) Logout(ctx context.Context) error {
	s.mu.Lock()
	sess, refresh, cfg := s.session, s.refresh, s.oauth
	s.mu.Unlock()
	if sess == nil {
		return nil
	}
	if cfg != nil && refresh != "" && s.opts.Hosted == nil {
		revoke := strings.TrimSuffix(sess.Issuer, "/") + "/protocol/openid-connect/revoke"
		form := url.Values{"client_id": {cfg.ClientID}, "token": {refresh}, "token_type_hint": {"refresh_token"}}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, revoke, strings.NewReader(form.Encode()))
		if err == nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			if resp, err := s.hc.Do(req); err == nil {
				_ = resp.Body.Close()
			} else {
				s.logger.Debug().Err(err).Msg("token revocation failed (ignored)")
			}
		}
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
	s.session, s.oauth, s.provider = nil, nil, nil
	s.access, s.refresh, s.expiry = "", "", time.Time{}
	s.mu.Unlock()
	if server != "" {
		_ = s.secrets.Delete(server)
	}
	if s.opts.Hosted == nil { // a hosted session keeps its device registration across sign-ins
		_ = deleteSession(s.opts.DataDir)
	}
	s.setState(func(st *State) { *st = State{Status: StatusSignedOut} })
}

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

const loopbackPage = `<!doctype html><html><head><meta charset="utf-8"><title>MemoBrain Notes</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1d1d1f}</style></head>
<body><div><h2>Signed in to MemoBrain Notes</h2><p>You can close this window and return to the app.</p></div>
<script>setTimeout(function(){window.close()},1500)</script></body></html>`
