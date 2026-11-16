//go:build !js

package auth

// The desktop sign-in: OpenID Connect discovery, Authorization Code + PKCE in the system browser
// with a loopback or custom-scheme redirect, token refresh with rotation and revocation at sign
// out. The browser build has none of it (oidc_js.go): its page owns the session (Options.Hosted).

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
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"clarae/apps/desktop/internal/sync/transport"
)

// idpClient is the OAuth client of a desktop session, on the endpoints found by discovery.
type idpClient = oauth2.Config

// login runs the browser flow against serverURL (Login checked the URL and the session state).
func (s *Service) login(ctx context.Context, serverURL string) error {
	client, err := transport.New(serverURL, nil, s.hc, "clarae-desktop/"+s.opts.AppVersion)
	if err != nil {
		return err
	}
	cc, err := client.GetClientConfig(ctx)
	if err != nil {
		return fmt.Errorf("server configuration: %w", err)
	}
	// The issuer comes from the server: it is held to the same rule as the
	// URL the user typed, and so are the endpoints it announces.
	if err := transport.CheckSecureURL(cc.Issuer); err != nil {
		return fmt.Errorf("identity provider: %w", err)
	}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, s.hc), cc.Issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	if err := checkEndpoint(provider.Endpoint()); err != nil {
		return err
	}
	cfg := &oauth2.Config{
		ClientID: cc.DesktopClientId,
		Endpoint: provider.Endpoint(),
		Scopes:   []string{oidc.ScopeOpenID, "profile", "email", oidc.ScopeOfflineAccess},
	}
	meta := s.discoveredMeta(provider, cc.Issuer)

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
		att.redirectURI = s.schemeRedirectURI(ctx, cfg)
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
	opts := []oauth2.AuthCodeOption{oauth2.AccessTypeOffline, oauth2.S256ChallengeOption(att.verifier)}
	if explicitLogoutPending(s.opts.DataDir) {
		// After an explicit sign-out the identity provider asks for the credentials again, even if
		// it still holds a session of the user (ADR-0058).
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "login"))
	}
	authURL := cfg.AuthCodeURL(att.state, opts...)
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
	s.idp, s.idpMeta = cfg, meta
	s.access, s.expiry, s.refresh = tok.AccessToken, tok.Expiry, tok.RefreshToken
	s.refreshUnsaved, s.keychainTried = false, time.Time{}
	s.session = &persisted{ServerURL: serverURL, Issuer: cc.Issuer, ClientID: cc.DesktopClientId, Audience: cc.Audience, GRPCEndpoint: cc.GrpcEndpoint}
	s.mu.Unlock()

	if err := s.secrets.Set(serverURL, tok.RefreshToken); err != nil {
		return fmt.Errorf("store refresh token: %w", err)
	}
	if err := s.completeSession(ctx); err != nil {
		return err
	}
	clearExplicitLogout(s.opts.DataDir) // the credentials were asked for: the marker has done its job
	return nil
}

// schemeRedirectURI picks the custom-scheme redirect URI: SchemeRedirectURI, or, when the identity
// provider rejects it and accepts the one of 1.x, LegacySchemeRedirectURI. A realm made for 1.x
// has only the old one registered, and the administrator has nothing to change for the new
// client to sign in. When both are rejected, or the provider cannot be asked, the current one
// stays: the failure is then the realm's, and the page of the provider says so.
func (s *Service) schemeRedirectURI(ctx context.Context, cfg *oauth2.Config) string {
	probe := *cfg
	probe.RedirectURL = SchemeRedirectURI
	if !s.redirectRejected(ctx, &probe) {
		return SchemeRedirectURI
	}
	probe.RedirectURL = LegacySchemeRedirectURI
	if s.redirectRejected(ctx, &probe) {
		return SchemeRedirectURI
	}
	s.logger.Warn().Msg("the identity provider does not know the redirect URI of this version, using the one of the previous version")
	return LegacySchemeRedirectURI
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

// refreshToken renews the access token with the refresh token, which the identity provider
// rotates. Token calls it when the access token in memory is missing or about to expire.
func (s *Service) refreshToken(ctx context.Context) (string, error) {
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
	cfg := s.idp
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
	s.reconnected()
	return tok.AccessToken, nil
}

// discoveredMeta reads the endpoints of the discovery document that oauth2 does not carry. The
// revocation endpoint falls back to the one of Keycloak, derived from the issuer, when the
// document does not announce it; the end-session endpoint has no fallback. An endpoint that
// is not https (or http on this computer) is dropped, like the ones of checkEndpoint.
func (s *Service) discoveredMeta(provider *oidc.Provider, issuer string) idpMeta {
	var claims struct {
		Revocation string `json:"revocation_endpoint"`
		EndSession string `json:"end_session_endpoint"`
	}
	if err := provider.Claims(&claims); err != nil {
		s.logger.Debug().Err(err).Msg("discovery: optional endpoints unreadable")
	}
	meta := idpMeta{RevocationEndpoint: claims.Revocation, EndSessionEndpoint: claims.EndSession}
	if meta.RevocationEndpoint == "" {
		meta.RevocationEndpoint = strings.TrimSuffix(issuer, "/") + "/protocol/openid-connect/revoke"
	}
	if transport.CheckSecureURL(meta.RevocationEndpoint) != nil {
		meta.RevocationEndpoint = ""
	}
	if transport.CheckSecureURL(meta.EndSessionEndpoint) != nil {
		meta.EndSessionEndpoint = ""
	}
	return meta
}

// endIdentityProviderSession ends the session of the user at the identity provider on sign out
// (best effort, ADR-0058). Without a browser: first a back-channel logout on the
// end_session_endpoint with the refresh token (Keycloak accepts it from a public client and
// ends the whole SSO session, the offline session of the token included), then the revocation
// of the token, which a provider without a back-channel logout still honours. The logout goes
// first because a revoked token no longer identifies the session it belongs to.
func (s *Service) endIdentityProviderSession(ctx context.Context, sess *persisted, refresh string) {
	if refresh == "" {
		return // nothing to present: the keychain was never read in this run
	}
	s.mu.Lock()
	cfg, meta := s.idp, s.idpMeta
	s.mu.Unlock()
	if cfg == nil {
		// Restored and not used yet: discovery has not run.
		if err := s.ensureOAuth(ctx, sess); err != nil {
			s.logger.Debug().Err(err).Msg("sign-out: identity provider unreachable (ignored)")
			return
		}
		s.mu.Lock()
		cfg, meta = s.idp, s.idpMeta
		s.mu.Unlock()
		if cfg == nil {
			return
		}
	}
	if meta.EndSessionEndpoint != "" {
		s.postIdP(ctx, "end session", meta.EndSessionEndpoint, url.Values{"client_id": {cfg.ClientID}, "refresh_token": {refresh}})
	}
	if meta.RevocationEndpoint != "" {
		s.postIdP(ctx, "token revocation", meta.RevocationEndpoint, url.Values{"client_id": {cfg.ClientID}, "token": {refresh}, "token_type_hint": {"refresh_token"}})
	}
}

// postIdP posts a form to an endpoint of the identity provider and logs what it answers: a
// failure never stops the sign-out.
func (s *Service) postIdP(ctx context.Context, what, endpoint string, form url.Values) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.hc.Do(req)
	if err != nil {
		s.logger.Debug().Err(err).Msgf("sign-out: %s failed (ignored)", what)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<10))
		s.logger.Warn().Int("status", resp.StatusCode).Str("body", string(body)).Msgf("sign-out: %s refused (ignored)", what)
	}
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

// checkEndpoint refuses an identity provider whose discovery document sends
// the authorization code or the refresh token in clear (transport.CheckSecureURL).
func checkEndpoint(ep oauth2.Endpoint) error {
	for _, u := range []string{ep.AuthURL, ep.TokenURL} {
		if err := transport.CheckSecureURL(u); err != nil {
			return fmt.Errorf("identity provider: %w", err)
		}
	}
	return nil
}

// ensureOAuth performs discovery lazily after a Restore (the issuer may have
// been unreachable at startup). It runs without s.mu and installs the result
// only if sess is still the current session.
func (s *Service) ensureOAuth(ctx context.Context, sess *persisted) error {
	s.mu.Lock()
	ready := s.idp != nil
	s.mu.Unlock()
	if ready {
		return nil
	}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, s.hc), sess.Issuer)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	if err := checkEndpoint(provider.Endpoint()); err != nil {
		return err
	}
	cfg := &oauth2.Config{ClientID: sess.ClientID, Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID, "profile", "email", oidc.ScopeOfflineAccess}}
	meta := s.discoveredMeta(provider, sess.Issuer)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != sess {
		return errors.New("not signed in")
	}
	if s.idp == nil {
		s.idp, s.idpMeta = cfg, meta
	}
	return nil
}

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

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

const loopbackPage = `<!doctype html><html><head><meta charset="utf-8"><title>Clarae notanda</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1d1d1f}</style></head>
<body><div><h2>Signed in to Clarae notanda</h2><p>You can close this window and return to the app.</p></div>
<script>setTimeout(function(){window.close()},1500)</script></body></html>`
