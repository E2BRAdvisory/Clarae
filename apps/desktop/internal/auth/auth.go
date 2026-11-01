// Package auth signs the desktop in to the cloud with OpenID Connect
// Authorization Code + PKCE in the system browser (§1.3, RFC 8252). The
// redirect is a loopback listener on a random port, with the custom scheme
// memobrain://auth/callback as fallback (D-08). The refresh token lives in the OS
// keychain; the access token only in memory.
package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
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

	mu       sync.Mutex
	state    State
	session  *persisted
	oauth    *oauth2.Config
	provider *oidc.Provider
	access   string
	expiry   time.Time
	refresh  string
	// refreshUnsaved marks a rotated refresh token the keychain refused.
	refreshUnsaved bool
	// keychainTried is when the keychain was last read for a session
	// restored without its refresh token (zero: not pending).
	keychainTried time.Time
	pending       *attempt
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
		ClientID: cc.DesktopClientId,
		Endpoint: provider.Endpoint(),
		Scopes:   []string{oidc.ScopeOpenID, "profile", "email", oidc.ScopeOfflineAccess},
	}

	att := &attempt{state: randomString(24), verifier: oauth2.GenerateVerifier(), result: make(chan url.Values, 1)}
	mode := s.redirectMode()
	if mode != RedirectScheme {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		switch {
		case err == nil:
			att.listener = ln
			att.redirectURI = fmt.Sprintf("http://127.0.0.1:%d/cb", ln.Addr().(*net.TCPAddr).Port)
		case mode == RedirectLoopback:
			return fmt.Errorf("loopback listener: %w", err)
		default:
			s.logger.Warn().Err(err).Msg("loopback listener unavailable, falling back to custom scheme")
		}
	}
	if att.listener != nil && mode == RedirectAuto {
		probe := *cfg
		probe.RedirectURL = att.redirectURI
		if s.redirectRejected(ctx, &probe) {
			s.logger.Warn().Msg("the identity provider rejects the loopback redirect, falling back to custom scheme")
			_ = att.listener.Close()
			att.listener, att.redirectURI = nil, ""
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
	s.refreshUnsaved, s.keychainTried = false, time.Time{}
	s.session = &persisted{ServerURL: serverURL, Issuer: cc.Issuer, ClientID: cc.DesktopClientId, Audience: cc.Audience, GRPCEndpoint: cc.GrpcEndpoint}
	s.mu.Unlock()

	if err := s.secrets.Set(serverURL, tok.RefreshToken); err != nil {
		return fmt.Errorf("store refresh token: %w", err)
	}
	return s.completeSession(ctx)
}

// redirectRejected asks the authorization endpoint, without a browser,
// whether it accepts cfg's redirect URI (D-08, rule b). Keycloak answers an
// unregistered one with a 400 error page ("Invalid parameter: redirect_uri")
// instead of redirecting, which in the browser would be a dead end. The probe
// carries a throwaway state and challenge, and its redirect is never
// followed: an accepted URI only yields the login page or a redirect. Any
// other outcome (network error, unexpected answer) keeps the loopback.
func (s *Service) redirectRejected(ctx context.Context, cfg *oauth2.Config) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	u := cfg.AuthCodeURL(randomString(24), oauth2.S256ChallengeOption(oauth2.GenerateVerifier()))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	hc := *s.hc
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := hc.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		return false
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return bytes.Contains(body, []byte("redirect_uri"))
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
	sess := s.session
	s.mu.Unlock()
	// Neither discovery nor the keychain run under s.mu: on a black-holed
	// network discovery takes up to the client timeout, and State, Client and
	// every API call would stall behind it. refreshMu keeps them serialized.
	if err := s.ensureOAuth(ctx, sess); err != nil {
		s.setDisconnected(err)
		return "", err
	}
	refresh, err := s.ensureRefresh(sess)
	if errors.Is(err, errNotSignedIn) {
		return "", err
	}
	if err != nil {
		s.setDisconnected(err)
		return "", err
	}
	s.mu.Lock()
	if s.session != sess {
		s.mu.Unlock()
		return "", errors.New("not signed in")
	}
	cfg := s.oauth
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
		s.setDisconnected(err)
		return "", err
	}
	s.mu.Lock()
	if s.session != sess { // signed out meanwhile
		s.mu.Unlock()
		return "", errors.New("not signed in")
	}
	s.access, s.expiry = tok.AccessToken, tok.Expiry
	server := s.session.ServerURL
	if tok.RefreshToken != "" && tok.RefreshToken != s.refresh {
		s.refresh, s.refreshUnsaved = tok.RefreshToken, true
	}
	unsaved, rt := s.refreshUnsaved, s.refresh
	s.mu.Unlock()
	if unsaved {
		s.storeRefresh(server, rt)
	}
	if s.State().Status == StatusDisconnected {
		s.setState(func(st *State) { st.Status = StatusReady; st.Error = "" })
	}
	return tok.AccessToken, nil
}

// storeRefresh keeps a rotated refresh token in the keychain. Should that
// fail, the token stays marked unsaved and the next refresh tries again: the
// old one is already spent (rotation), so the next start would be signed out.
func (s *Service) storeRefresh(server, rt string) {
	if err := s.secrets.Set(server, rt); err != nil {
		s.logger.Error().Err(err).Msg("store rotated refresh token; will retry at the next refresh")
		return
	}
	s.mu.Lock()
	if s.refresh == rt {
		s.refreshUnsaved = false
	}
	s.mu.Unlock()
}

// ensureOAuth performs discovery lazily after a Restore (the issuer may have
// been unreachable at startup). It runs without s.mu and installs the result
// only if sess is still the current session.
func (s *Service) ensureOAuth(ctx context.Context, sess *persisted) error {
	s.mu.Lock()
	ready := s.oauth != nil
	s.mu.Unlock()
	if ready {
		return nil
	}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, s.hc), sess.Issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	cfg := &oauth2.Config{ClientID: sess.ClientID, Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID, "profile", "email", oidc.ScopeOfflineAccess}}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != sess {
		return errors.New("not signed in")
	}
	if s.oauth == nil {
		s.provider, s.oauth = provider, cfg
	}
	return nil
}

// defaultKeychainRetry spaces the keychain reads of a session restored while
// the keychain was unavailable (a dismissed prompt must not come back on
// every call).
const defaultKeychainRetry = 30 * time.Second

// ensureRefresh returns the refresh token of sess. A session restored while
// the keychain could not be read has none yet: it is read again (at most
// every keychainRetry), and only an entry that is really missing signs out.
func (s *Service) ensureRefresh(sess *persisted) (string, error) {
	s.mu.Lock()
	refresh, last := s.refresh, s.keychainTried
	s.mu.Unlock()
	if refresh != "" {
		return refresh, nil
	}
	if !last.IsZero() && time.Since(last) < s.keychainRetry {
		return "", errKeychainUnavailable
	}
	v, err := s.secrets.Get(sess.ServerURL)
	s.mu.Lock()
	s.keychainTried = time.Now()
	if s.session == sess && err == nil && v != "" {
		s.refresh = v
	}
	s.mu.Unlock()
	switch {
	case err != nil:
		s.logger.Warn().Err(err).Msg("keychain unavailable; refresh token not read")
		return "", errKeychainUnavailable
	case v == "":
		s.logger.Info().Msg("no refresh token in keychain; signed out")
		s.mu.Lock()
		current := s.session == sess
		s.mu.Unlock()
		if current {
			s.clearSession()
		}
		return "", errNotSignedIn
	}
	return v, nil
}

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
	s.refreshUnsaved, s.keychainTried = false, time.Time{}
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
