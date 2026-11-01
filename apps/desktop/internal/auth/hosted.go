package auth

import (
	"context"
	"errors"
	"sync"
	"time"
)

// HostedDevice keeps the device registration of a hosted session somewhere a wipe of the data
// directory does not reach. In the browser the data directory lives in the origin's private file
// system, which "sign out" and "forget this browser" delete; without this every sign-in would
// register a new device (ADR-0029, P6). The web host stores it in IndexedDB, per server.
type HostedDevice interface {
	// LoadDevice returns the device remembered for serverURL and the account it belongs to, or
	// empty strings when there is none.
	LoadDevice(ctx context.Context, serverURL string) (deviceID, userID string, err error)
	// SaveDevice remembers the device of the account userID for serverURL.
	SaveDevice(ctx context.Context, serverURL, deviceID, userID string) error
}

// hostedDevices maps a *Hosted to its HostedDevice (set with WithDevice).
var hostedDevices sync.Map

// WithDevice attaches the store of the device registration to a hosted session and returns h.
func (h *Hosted) WithDevice(d HostedDevice) *Hosted {
	if h != nil && d != nil {
		hostedDevices.Store(h, d)
	}
	return h
}

func (h *Hosted) device() HostedDevice {
	if h == nil {
		return nil
	}
	if d, ok := hostedDevices.Load(h); ok {
		return d.(HostedDevice)
	}
	return nil
}

// hostDeviceTimeout bounds a call to the host's device store (it must never hold the sign-in up).
const hostDeviceTimeout = 5 * time.Second

// hostedSession returns the session of a hosted service, created on first use from the device
// registration remembered in the data directory or, when the directory was wiped, by the host.
func (s *Service) hostedSession() *persisted {
	s.mu.Lock()
	if s.session != nil {
		defer s.mu.Unlock()
		return s.session
	}
	s.mu.Unlock()
	sess := &persisted{ServerURL: s.opts.Hosted.ServerURL}
	if prev, err := readSession(s.opts.DataDir, false); err == nil && prev != nil && prev.ServerURL == sess.ServerURL {
		sess.DeviceID, sess.DeviceRevoked, sess.Profile = prev.DeviceID, prev.DeviceRevoked, prev.Profile
	}
	if d := s.opts.Hosted.device(); d != nil && sess.DeviceID == "" {
		ctx, cancel := context.WithTimeout(context.Background(), hostDeviceTimeout)
		id, user, err := d.LoadDevice(ctx, sess.ServerURL)
		cancel()
		if err != nil {
			s.logger.Warn().Err(err).Msg("hosted device store unavailable")
		} else if id != "" && user != "" {
			// completeSession drops it if another account signs in.
			sess.DeviceID, sess.Profile = id, Profile{UserID: user}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session == nil {
		s.session = sess
	}
	return s.session
}

func (s *Service) hostedToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	signedIn := s.session != nil
	s.mu.Unlock()
	if !signedIn {
		return "", errors.New("not signed in")
	}
	tok, err := s.opts.Hosted.Token(ctx)
	if err != nil {
		s.setDisconnected(err)
		return "", err
	}
	if tok == "" {
		return "", errors.New("the host page has no access token")
	}
	if s.State().Status == StatusDisconnected {
		s.setState(func(st *State) { st.Status = StatusReady; st.Error = "" })
	}
	return tok, nil
}

// hostedLogin starts the session on behalf of the page: it loads the profile and registers the
// browser as a device if it is not one yet (or no longer: a device revoked from the console is
// replaced by a new registration). The registration is handed to the host's device store, so it
// survives a wipe of the data directory.
func (s *Service) hostedLogin(ctx context.Context) error {
	sess := s.hostedSession()
	s.setState(func(st *State) { st.Status = StatusSigningIn; st.ServerURL = s.opts.Hosted.ServerURL; st.Error = "" })
	d := s.opts.Hosted.device()
	if d != nil {
		s.dropRevokedDevice(ctx, sess)
	}
	if err := s.completeSession(ctx); err != nil {
		s.logger.Warn().Err(err).Msg("hosted login failed")
		s.setDisconnected(err)
		return err
	}
	if d != nil {
		s.mu.Lock()
		id, user := sess.DeviceID, sess.Profile.UserID
		s.mu.Unlock()
		sctx, cancel := context.WithTimeout(ctx, hostDeviceTimeout)
		defer cancel()
		if err := d.SaveDevice(sctx, sess.ServerURL, id, user); err != nil {
			s.logger.Warn().Err(err).Msg("could not remember the browser's device")
		}
	}
	return nil
}

// dropRevokedDevice forgets a remembered device that is no longer among the account's active ones,
// so completeSession registers a new one. When the list cannot be read the device is kept.
func (s *Service) dropRevokedDevice(ctx context.Context, sess *persisted) {
	s.mu.Lock()
	id := sess.DeviceID
	s.mu.Unlock()
	if id == "" {
		return
	}
	client := s.Client()
	if client == nil {
		return
	}
	devices, err := client.ListDevices(ctx)
	if err != nil {
		return
	}
	for _, dev := range devices {
		if dev.Id.String() == id && dev.RevokedAt == nil {
			return
		}
	}
	s.mu.Lock()
	if sess.DeviceID == id {
		sess.DeviceID, sess.DeviceRevoked = "", false
	}
	s.mu.Unlock()
}

func (s *Service) restoreHosted(ctx context.Context) {
	sess := s.hostedSession()
	s.setState(func(st *State) {
		st.Status, st.ServerURL, st.Profile, st.DeviceID = StatusDisconnected, sess.ServerURL, sess.Profile, sess.DeviceID
		if sess.DeviceRevoked {
			st.Status, st.Error = StatusDeviceRevoked, DeviceRevokedMessage
		}
	})
	go func() { _ = s.hostedLogin(ctx) }()
}
