// Package updater implements the desktop update channel: a signed manifest is
// fetched (the only network request, no identifiers), verified BEFORE it is
// parsed, compared against the running version with rollback/replay
// protection, and the matching artifact is downloaded, hash-checked and
// staged atomically. Applying the update is per OS (apply.go).
//
// Privacy: the updater sends two plain GET requests (manifest and signature)
// with a fixed User-Agent, no cookies, no version, no device or user id.
package updater

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"memobrain/shared/updatemanifest"
)

// Errors.
var (
	ErrDisabled     = errors.New("updater: updates are disabled")
	ErrNoUpdate     = errors.New("updater: no update available")
	ErrNoArtifact   = errors.New("updater: no artifact for this platform")
	ErrReplay       = errors.New("updater: manifest sequence is older than one already seen (replay or rollback)")
	ErrRevoked      = errors.New("updater: manifest version is below the revocation floor")
	ErrChannel      = errors.New("updater: manifest is for another channel")
	ErrTooLarge     = errors.New("updater: response exceeds the size limit")
	ErrHashMismatch = errors.New("updater: downloaded file does not match the signed sha256")
	ErrInsecureURL  = errors.New("updater: artifact URL must be https")
)

// Limits.
const (
	maxManifestBytes = 256 << 10
	maxSigBytes      = 1 << 10
	userAgent        = "MemobrainUpdater"
	// CheckInterval is the period of automatic checks (a random jitter is added).
	CheckInterval = 24 * time.Hour
)

// States of Status.State.
const (
	StateIdle        = "idle"
	StateChecking    = "checking"
	StateUpToDate    = "up-to-date"
	StateAvailable   = "available"
	StateDownloading = "downloading"
	StateReady       = "ready" // downloaded and verified
	StateError       = "error"
)

// Settings are the user preferences, persisted in <data dir>/updater.json.
type Settings struct {
	Enabled        bool   `json:"enabled"` // automatic checks (startup and every 24 h)
	Channel        string `json:"channel"` // stable | beta
	SkippedVersion string `json:"skippedVersion"`
}

// state is the persisted internal bookkeeping (never shown as a setting).
type state struct {
	Settings
	LastCheck time.Time        `json:"lastCheck"`
	Sequences map[string]int64 `json:"sequences"` // highest sequence seen per channel
	Floor     string           `json:"floor"`     // highest min_version seen
}

// Status is what the UI shows.
type Status struct {
	State    string    `json:"state"`
	Current  string    `json:"current"`
	Latest   string    `json:"latest"`
	Channel  string    `json:"channel"`
	Notes    string    `json:"notes"`
	NotesURL string    `json:"notesUrl"`
	Released time.Time `json:"released"`
	Required bool      `json:"required"` // the running version is below the revocation floor
	Skipped  bool      `json:"skipped"`
	Kind     string    `json:"kind"` // artifact kind that will be installed
	Size     int64     `json:"size"`
	Done     int64     `json:"done"` // bytes downloaded
	Error    string    `json:"error"`
	// Warning is a problem that does not stop the update, e.g. a manifest
	// past its expires_at (the update server may be frozen on an old one).
	Warning   string    `json:"warning,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`
	// Disabled is a non-empty reason when updates cannot run at all (managed, dev build).
	Disabled string `json:"disabled"`
}

// Options configure the Service. Zero values pick production defaults.
type Options struct {
	DataDir        string
	CurrentVersion string
	PublicKey      ed25519.PublicKey // default: the build key
	BaseURL        string            // default: ManifestBaseURL
	HTTPClient     *http.Client
	OS, Arch       string // default runtime.GOOS/GOARCH
	Now            func() time.Time
	Applier        Applier
	OnStatus       func(Status)
	// DisabledReason, when set, disables the updater (managed configuration).
	DisabledReason string
	// StartupDelay postpones the first automatic check (default 45 s).
	StartupDelay time.Duration
	// AllowInsecureLoopback permits http:// artifact URLs on loopback hosts (tests, local servers).
	AllowInsecureLoopback bool
}

// Service is the updater. Safe for concurrent use.
type Service struct {
	opts Options
	pub  ed25519.PublicKey

	mu       sync.Mutex
	st       state
	status   Status
	manifest *updatemanifest.Manifest
	art      updatemanifest.Artifact
	staged   string
	busy     bool
}

// New loads the persisted state and prepares the service.
func New(opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.OS == "" {
		opts.OS = runtime.GOOS
	}
	if opts.Arch == "" {
		opts.Arch = runtime.GOARCH
	}
	if opts.BaseURL == "" {
		opts.BaseURL = ManifestBaseURL
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	if opts.StartupDelay == 0 {
		opts.StartupDelay = 45 * time.Second
	}
	if opts.Applier == nil {
		opts.Applier = NewSystemApplier()
	}
	s := &Service{opts: opts}
	var err error
	if opts.PublicKey != nil {
		s.pub = opts.PublicKey
	} else if s.pub, err = publicKey(); err != nil {
		return nil, fmt.Errorf("updater: build public key: %w", err)
	}
	if opts.DisabledReason == "" {
		if DisabledByBuild == "1" {
			s.opts.DisabledReason = "updates are managed by the distribution package"
		} else if _, err := updatemanifest.ParseVersion(opts.CurrentVersion); err != nil {
			s.opts.DisabledReason = "development build"
		}
	}
	s.st = state{Settings: Settings{Enabled: true, Channel: updatemanifest.ChannelStable}, Sequences: map[string]int64{}}
	s.load()
	s.status = Status{State: StateIdle, Current: opts.CurrentVersion, Channel: s.st.Channel, Disabled: s.opts.DisabledReason}
	return s, nil
}

func (s *Service) path() string { return filepath.Join(s.opts.DataDir, "updater.json") }

func (s *Service) load() {
	raw, err := os.ReadFile(s.path())
	if err != nil {
		return
	}
	var st state
	if json.Unmarshal(raw, &st) != nil {
		return // a corrupt file falls back to defaults; sequences restart (still signature-protected)
	}
	if st.Channel != updatemanifest.ChannelStable && st.Channel != updatemanifest.ChannelBeta {
		st.Channel = updatemanifest.ChannelStable
	}
	if st.Sequences == nil {
		st.Sequences = map[string]int64{}
	}
	s.st = st
}

// saveLocked writes the state atomically (tmp + fsync + rename).
func (s *Service) saveLocked() error {
	raw, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path(), raw, 0o600)
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil && runtime.GOOS != "windows" {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Settings returns the user preferences.
func (s *Service) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.Settings
}

// SetSettings validates and persists the preferences.
func (s *Service) SetSettings(in Settings) error {
	if in.Channel != updatemanifest.ChannelStable && in.Channel != updatemanifest.ChannelBeta {
		return fmt.Errorf("updater: invalid channel %q", in.Channel)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.Channel != s.st.Channel {
		s.manifest, s.staged = nil, ""
		s.status = Status{State: StateIdle, Current: s.opts.CurrentVersion, Channel: in.Channel, Disabled: s.opts.DisabledReason}
	}
	s.st.Settings = in
	return s.saveLocked()
}

// Status returns the current status.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Service) setStatus(f func(*Status)) {
	s.mu.Lock()
	f(&s.status)
	st := s.status
	s.mu.Unlock()
	if s.opts.OnStatus != nil {
		s.opts.OnStatus(st)
	}
}

// Skip hides the notification for this version (a newer one is announced again).
func (s *Service) Skip(version string) error {
	s.mu.Lock()
	s.st.SkippedVersion = version
	err := s.saveLocked()
	s.mu.Unlock()
	s.setStatus(func(st *Status) { st.Skipped = st.Latest == version })
	return err
}

func (s *Service) fetch(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := s.opts.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("updater: GET %s: %s", redact(rawURL), resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, ErrTooLarge
	}
	return body, nil
}

func redact(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(invalid url)"
	}
	return u.Scheme + "://" + u.Host + u.Path
}

// Check fetches and verifies the manifest of the selected channel. A manual
// call works even when automatic checks are switched off.
func (s *Service) Check(ctx context.Context) (Status, error) {
	if s.opts.DisabledReason != "" {
		return s.Status(), fmt.Errorf("%w: %s", ErrDisabled, s.opts.DisabledReason)
	}
	s.mu.Lock()
	if s.busy {
		st := s.status
		s.mu.Unlock()
		return st, nil
	}
	s.busy = true
	channel := s.st.Channel
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.busy = false; s.mu.Unlock() }()

	s.setStatus(func(st *Status) { *st = Status{State: StateChecking, Current: s.opts.CurrentVersion, Channel: channel} })
	m, err := s.fetchManifest(ctx, channel)
	if err != nil {
		s.setStatus(func(st *Status) {
			*st = Status{State: StateError, Current: s.opts.CurrentVersion, Channel: channel, Error: err.Error(), CheckedAt: s.opts.Now()}
		})
		return s.Status(), err
	}
	return s.evaluate(m)
}

func (s *Service) fetchManifest(ctx context.Context, channel string) (*updatemanifest.Manifest, error) {
	base := strings.TrimRight(s.opts.BaseURL, "/") + "/" + channel + "/manifest.json"
	raw, err := s.fetch(ctx, base, maxManifestBytes)
	if err != nil {
		return nil, err
	}
	sig, err := s.fetch(ctx, base+".sig", maxSigBytes)
	if err != nil {
		return nil, err
	}
	// Signature first: nothing in the manifest is looked at before this succeeds.
	m, err := updatemanifest.VerifyAndParse(s.pub, raw, sig)
	if err != nil {
		return nil, err
	}
	if m.Channel != channel {
		return nil, ErrChannel
	}
	return m, nil
}

// evaluate applies the anti-rollback rules, records the progress and sets the status.
func (s *Service) evaluate(m *updatemanifest.Manifest) (Status, error) {
	s.mu.Lock()
	if m.Sequence < s.st.Sequences[m.Channel] {
		s.mu.Unlock()
		s.fail(ErrReplay)
		return s.Status(), ErrReplay
	}
	floor := s.st.Floor
	if m.MinVersion != "" {
		if c, _ := updatemanifest.CompareVersions(m.MinVersion, floor); floor == "" || c > 0 {
			floor = m.MinVersion
		}
	}
	if floor != "" {
		if c, _ := updatemanifest.CompareVersions(m.Version, floor); c < 0 {
			s.mu.Unlock()
			s.fail(ErrRevoked)
			return s.Status(), ErrRevoked
		}
	}
	s.st.Sequences[m.Channel] = m.Sequence
	s.st.Floor = floor
	s.st.LastCheck = s.opts.Now()
	skipped := s.st.SkippedVersion
	_ = s.saveLocked()
	s.mu.Unlock()

	cmp, err := updatemanifest.CompareVersions(m.Version, s.opts.CurrentVersion)
	if err != nil {
		s.fail(err)
		return s.Status(), err
	}
	base := Status{Current: s.opts.CurrentVersion, Channel: m.Channel, Latest: m.Version, CheckedAt: s.opts.Now()}
	if err := m.CheckFresh(s.opts.Now()); err != nil {
		// Signed and newer than what was seen, but no longer refreshed:
		// keep working (a dead server must not block the app) and say so.
		base.Warning = "the update information has expired (" + err.Error() + "): newer releases may not be announced"
	}
	if cmp <= 0 { // same or older release: never a downgrade
		base.State = StateUpToDate
		s.setStatus(func(st *Status) { *st = base })
		return s.Status(), nil
	}
	art, ok := m.Select(s.opts.OS, s.opts.Arch, s.opts.Applier.PreferredKinds(s.opts.OS))
	if !ok {
		s.fail(ErrNoArtifact)
		return s.Status(), ErrNoArtifact
	}
	required := false
	if floor != "" {
		if c, _ := updatemanifest.CompareVersions(s.opts.CurrentVersion, floor); c < 0 {
			required = true
		}
	}
	s.mu.Lock()
	s.manifest, s.art, s.staged = m, art, ""
	s.mu.Unlock()
	base.State = StateAvailable
	base.Notes, base.NotesURL, base.Released = m.Notes, m.NotesURL, m.ReleasedAt
	base.Kind, base.Size, base.Required = art.Kind, art.Size, required
	base.Skipped = skipped == m.Version && !required
	s.setStatus(func(st *Status) { *st = base })
	return s.Status(), nil
}

func (s *Service) fail(err error) {
	s.setStatus(func(st *Status) {
		st.State, st.Error, st.CheckedAt = StateError, err.Error(), s.opts.Now()
	})
}

func (s *Service) checkArtifactURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" && s.opts.AllowInsecureLoopback {
		if ip := net.ParseIP(u.Hostname()); (ip != nil && ip.IsLoopback()) || u.Hostname() == "localhost" {
			return nil
		}
	}
	return ErrInsecureURL
}

// stageName is the file name of a staged artifact (never taken from the URL).
func stageName(version string, a updatemanifest.Artifact) string {
	ext := map[string]string{updatemanifest.KindDMG: ".dmg", updatemanifest.KindNSIS: ".exe", updatemanifest.KindAppImage: ".AppImage", updatemanifest.KindDeb: ".deb"}[a.Kind]
	return fmt.Sprintf("memobrain-%s-%s-%s%s", version, a.OS, a.Arch, ext)
}

// Download fetches the artifact of the last Check into <data dir>/updates,
// verifying size and sha256 before the atomic rename. It returns the staged path.
func (s *Service) Download(ctx context.Context) (string, error) {
	s.mu.Lock()
	m, art, staged := s.manifest, s.art, s.staged
	s.mu.Unlock()
	if m == nil {
		return "", ErrNoUpdate
	}
	if staged != "" {
		if _, err := os.Stat(staged); err == nil {
			return staged, nil
		}
	}
	if err := s.checkArtifactURL(art.URL); err != nil {
		return "", err
	}
	dir := filepath.Join(s.opts.DataDir, "updates")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	final := filepath.Join(dir, stageName(m.Version, art))
	tmp, err := os.CreateTemp(dir, "download-*.part")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // no-op after the rename
	s.setStatus(func(st *Status) { st.State, st.Done, st.Error = StateDownloading, 0, "" })

	if err := s.copyVerified(ctx, tmp, art); err != nil {
		_ = tmp.Close()
		s.fail(err)
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil && runtime.GOOS != "windows" {
		return "", err
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return "", err
	}
	s.mu.Lock()
	s.staged = final
	s.mu.Unlock()
	s.setStatus(func(st *Status) { st.State, st.Done = StateReady, art.Size })
	return final, nil
}

func (s *Service) copyVerified(ctx context.Context, dst io.Writer, art updatemanifest.Artifact) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, art.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	// Artifacts can be large: no overall client timeout, the context bounds the download.
	client := *s.opts.HTTPClient
	client.Timeout = 0
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("updater: download: %s", resp.Status)
	}
	if resp.ContentLength > art.Size {
		return ErrTooLarge
	}
	h := sha256.New()
	var done int64
	buf := make([]byte, 64<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			done += int64(n)
			if done > art.Size { // never write more than the signed size
				return ErrTooLarge
			}
			h.Write(buf[:n])
			if _, err := dst.Write(buf[:n]); err != nil {
				return err
			}
			d := done
			s.setStatus(func(st *Status) { st.Done = d })
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if done != art.Size || !bytes.Equal([]byte(hex.EncodeToString(h.Sum(nil))), []byte(art.SHA256)) {
		return ErrHashMismatch
	}
	return nil
}

// Install downloads (if needed) and applies the update. The returned Result
// tells the caller whether the application must quit now.
func (s *Service) Install(ctx context.Context) (Result, error) {
	path, err := s.Download(ctx)
	if err != nil {
		return Result{}, err
	}
	s.mu.Lock()
	art := s.art
	s.mu.Unlock()
	res, err := s.opts.Applier.Apply(ctx, path, art)
	if err != nil {
		s.fail(err)
	}
	return res, err
}

// Run performs the automatic checks until ctx ends: once after the startup
// delay (or when the last check is older than 24 h) and then every 24 h plus
// up to 2 h of random jitter. Disabled or opted-out installs never fetch.
func (s *Service) Run(ctx context.Context) {
	if s.opts.DisabledReason != "" {
		return
	}
	delay := s.opts.StartupDelay
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		s.mu.Lock()
		enabled, last := s.st.Enabled, s.st.LastCheck
		s.mu.Unlock()
		if enabled && s.opts.Now().Sub(last) >= CheckInterval-time.Minute {
			_, _ = s.Check(ctx)
		}
		delay = CheckInterval + time.Duration(rand.Int64N(int64(2*time.Hour))) //nolint:gosec // schedule jitter, not security relevant
		if !enabled {
			delay = time.Hour // re-read the preference now and then
		}
	}
}
