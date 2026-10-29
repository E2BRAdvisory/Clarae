package auth

import (
	"context"
	"errors"
)

// hostedSession returns the session of a hosted service, created on first use from the device
// registration remembered in the data directory.
func (s *Service) hostedSession() *persisted {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session == nil {
		sess := &persisted{ServerURL: s.opts.Hosted.ServerURL}
		if prev, err := readSession(s.opts.DataDir, false); err == nil && prev != nil && prev.ServerURL == sess.ServerURL {
			sess.DeviceID, sess.Profile = prev.DeviceID, prev.Profile
		}
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
		s.setState(func(st *State) { st.Status = StatusDisconnected; st.Error = err.Error() })
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
// browser as a device if it is not one yet.
func (s *Service) hostedLogin(ctx context.Context) error {
	s.hostedSession()
	s.setState(func(st *State) { st.Status = StatusSigningIn; st.ServerURL = s.opts.Hosted.ServerURL; st.Error = "" })
	if err := s.completeSession(ctx); err != nil {
		s.logger.Warn().Err(err).Msg("hosted login failed")
		s.setState(func(st *State) { st.Status = StatusDisconnected; st.Error = err.Error() })
		return err
	}
	return nil
}

func (s *Service) restoreHosted(ctx context.Context) {
	sess := s.hostedSession()
	s.setState(func(st *State) {
		st.Status, st.ServerURL, st.Profile, st.DeviceID = StatusDisconnected, sess.ServerURL, sess.Profile, sess.DeviceID
	})
	go func() { _ = s.hostedLogin(ctx) }()
}
