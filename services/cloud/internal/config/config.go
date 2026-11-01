// Package config loads the cloud service configuration from the environment
// (12-factor). Every variable is documented in deploy/docker/cloud.dev.env.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Role selects what a process does.
type Role string

// Process roles (`--role` flag).
const (
	RoleAPI    Role = "api"
	RoleWorker Role = "worker"
	RoleAll    Role = "all"
)

// Config is the complete service configuration.
type Config struct {
	Role    Role
	Version string

	ListenAddr     string
	GRPCListenAddr string
	// MetricsListenAddr is the internal listener of the worker role
	// (/metrics, /healthz, /readyz); the API role serves them on ListenAddr.
	MetricsListenAddr string
	WebUIOrigin       string
	LogLevel          string
	// TrustedProxies are the networks of the reverse proxies whose
	// X-Forwarded-For header is believed when resolving the client address
	// (rate limiting). Empty: the TCP peer is the client.
	TrustedProxies []netip.Prefix

	DatabaseURL string

	S3 S3Config

	// StorageDir stores blobs on the local filesystem when S3_ENDPOINT is
	// empty (single-node development and tests).
	StorageDir string

	OIDC OIDCConfig

	Keycloak KeycloakConfig

	// Shutdown bounds graceful shutdown.
	ShutdownTimeout time.Duration
	// ShutdownDrain is how long the API keeps serving after readiness turned
	// unavailable, so the load balancer drops the pod before connections are refused.
	ShutdownDrain time.Duration

	// AllowPlaceholderSecrets lets the process start although a secret still
	// holds a sample value of the deployment templates (tests and demos only).
	AllowPlaceholderSecrets bool
}

// S3Config configures the object store.
type S3Config struct {
	Endpoint      string
	AccessKey     string
	SecretKey     string
	Region        string
	BucketBlobs   string
	BucketExports string
	UsePathStyle  bool
	// PublicEndpoint is where clients reach the store (presigned export URLs); empty
	// serves exports through the API.
	PublicEndpoint string
}

// OIDCConfig configures bearer token validation.
type OIDCConfig struct {
	Issuer   string
	Audience string
	// AllowedAZP lists the client ids (azp claim) allowed to call the API.
	AllowedAZP []string
	// DesktopClientID is the public OIDC client the desktop app uses; served
	// by GET /client-config so clients only need the server URL.
	DesktopClientID string
	// WebClientID is the public OIDC client of the Web UI, also served by
	// GET /client-config.
	WebClientID string
	// PublicGRPCAddr is the host:port clients use to reach the notify stream
	// (behind an ingress it differs from the listen address).
	PublicGRPCAddr string
	// StatusCacheTTL bounds how long a user's status is cached (§1.3: 30 s).
	StatusCacheTTL time.Duration
}

// KeycloakConfig configures the Admin REST API client (service account).
type KeycloakConfig struct {
	BaseURL      string
	Realm        string
	ClientID     string
	ClientSecret string
}

// Load reads the configuration from the environment and validates it. A
// duration or boolean that does not parse is an error naming the variable,
// never a silent fallback to the default.
func Load(role Role, version string) (Config, error) {
	var p envParser
	envDuration, envBool := p.duration, p.boolean
	c := Config{
		Role:              role,
		Version:           version,
		ListenAddr:        env("LISTEN_ADDR", "127.0.0.1:18081"),
		GRPCListenAddr:    env("GRPC_LISTEN_ADDR", "127.0.0.1:18082"),
		MetricsListenAddr: env("METRICS_LISTEN_ADDR", "127.0.0.1:18083"),
		WebUIOrigin:       env("WEB_UI_ORIGIN", ""),
		LogLevel:          env("LOG_LEVEL", "info"),
		DatabaseURL:       env("DATABASE_URL", ""),
		ShutdownTimeout:   envDuration("SHUTDOWN_TIMEOUT", 15*time.Second),
		ShutdownDrain:     envDuration("SHUTDOWN_DRAIN", 5*time.Second),
		StorageDir:        env("STORAGE_DIR", ""),
		// The escape hatch for the placeholder check below: never set it in production.
		AllowPlaceholderSecrets: envBool("MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS", false),
		S3: S3Config{
			Endpoint:       env("S3_ENDPOINT", ""),
			AccessKey:      env("S3_ACCESS_KEY", ""),
			SecretKey:      env("S3_SECRET_KEY", ""),
			Region:         env("S3_REGION", "us-east-1"),
			BucketBlobs:    env("S3_BUCKET_BLOBS", "memobrain-blobs"),
			BucketExports:  env("S3_BUCKET_EXPORTS", "memobrain-exports"),
			UsePathStyle:   envBool("S3_USE_PATH_STYLE", true),
			PublicEndpoint: env("S3_PUBLIC_ENDPOINT", ""),
		},
		OIDC: OIDCConfig{
			Issuer:          env("OIDC_ISSUER", ""),
			Audience:        env("OIDC_AUDIENCE", "memobrain-api"),
			AllowedAZP:      envList("OIDC_ALLOWED_AZP", "memobrain-desktop,memobrain-web"),
			DesktopClientID: env("OIDC_DESKTOP_CLIENT_ID", "memobrain-desktop"),
			WebClientID:     env("OIDC_WEB_CLIENT_ID", "memobrain-web"),
			PublicGRPCAddr:  env("PUBLIC_GRPC_ADDR", env("GRPC_LISTEN_ADDR", "127.0.0.1:18082")),
			StatusCacheTTL:  envDuration("OIDC_STATUS_CACHE_TTL", 30*time.Second),
		},
		Keycloak: KeycloakConfig{
			BaseURL:      env("KC_ADMIN_BASE_URL", ""),
			Realm:        env("KC_REALM", "memobrain"),
			ClientID:     env("KC_ADMIN_CLIENT_ID", "memobrain-admin-svc"),
			ClientSecret: env("KC_ADMIN_CLIENT_SECRET", ""),
		},
	}
	proxies, err := parsePrefixes(envList("TRUSTED_PROXIES", ""))
	c.TrustedProxies = proxies
	return c, errors.Join(errors.Join(p.errs...), err, c.validate())
}

// parsePrefixes reads CIDRs or bare addresses (a single host).
func parsePrefixes(list []string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, s := range list {
		if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(s)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXIES: %q is neither a CIDR nor an address", s)
		}
		out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
	}
	return out, nil
}

func (c Config) validate() error {
	var errs []error
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}
	if c.Role != RoleWorker {
		if c.OIDC.Issuer == "" {
			errs = append(errs, errors.New("OIDC_ISSUER is required"))
		}
		if c.OIDC.Audience == "" {
			errs = append(errs, errors.New("OIDC_AUDIENCE is required"))
		}
	}
	if c.S3.Endpoint == "" && c.StorageDir == "" {
		errs = append(errs, errors.New("S3_ENDPOINT (or STORAGE_DIR for a local directory) is required"))
	}
	switch c.Role {
	case RoleAPI, RoleWorker, RoleAll:
	default:
		errs = append(errs, fmt.Errorf("unknown role %q", c.Role))
	}
	if c.ShutdownTimeout <= 0 {
		errs = append(errs, fmt.Errorf("SHUTDOWN_TIMEOUT must be positive, got %s", c.ShutdownTimeout))
	}
	if c.ShutdownDrain < 0 {
		errs = append(errs, fmt.Errorf("SHUTDOWN_DRAIN cannot be negative, got %s", c.ShutdownDrain))
	}
	// §1.3: a suspension takes effect within 30 s; a longer cache breaks that
	// promise, a negative one makes no sense (0 disables the cache).
	if c.OIDC.StatusCacheTTL < 0 || c.OIDC.StatusCacheTTL > 5*time.Minute {
		errs = append(errs, fmt.Errorf("OIDC_STATUS_CACHE_TTL must be between 0 and 5m, got %s", c.OIDC.StatusCacheTTL))
	}
	if names := c.PlaceholderSecrets(); len(names) > 0 && !c.AllowPlaceholderSecrets {
		errs = append(errs, fmt.Errorf("placeholder secret of the deployment template (%[2]s) in %[1]s: "+
			"set real secrets (MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS=1 skips this check, for tests only)",
			strings.Join(names, ", "), strings.Join(placeholderValues, ", ")))
	}
	return errors.Join(errs...)
}

// placeholderValues are the sample secrets of deploy/compose/.env.example and of
// the Helm chart: a deployment still using one was never configured.
var placeholderValues = []string{"change-me", "change-me-too", "changeme"}

func isPlaceholder(v string) bool {
	v = strings.TrimSpace(v)
	for _, p := range placeholderValues {
		if strings.EqualFold(v, p) {
			return true
		}
	}
	return false
}

// PlaceholderSecrets names the secret settings that still hold a placeholder
// value (whether or not AllowPlaceholderSecrets lets the process start).
func (c Config) PlaceholderSecrets() []string {
	var names []string
	if isPlaceholder(databasePassword(c.DatabaseURL)) {
		names = append(names, "DATABASE_URL (password)")
	}
	for _, s := range []struct{ name, value string }{
		{"S3_ACCESS_KEY", c.S3.AccessKey},
		{"S3_SECRET_KEY", c.S3.SecretKey},
		{"KC_ADMIN_CLIENT_SECRET", c.Keycloak.ClientSecret},
	} {
		if isPlaceholder(s.value) {
			names = append(names, s.name)
		}
	}
	return names
}

// databasePassword returns the password of a PostgreSQL connection string, in URL
// (postgres://user:password@host/db, or ?password=) or keyword/value form.
func databasePassword(dsn string) string {
	if u, err := url.Parse(dsn); err == nil && (u.Scheme == "postgres" || u.Scheme == "postgresql") {
		if p, ok := u.User.Password(); ok {
			return p
		}
		return u.Query().Get("password")
	}
	for _, field := range strings.Fields(dsn) {
		if k, v, ok := strings.Cut(field, "="); ok && k == "password" {
			return strings.Trim(v, "'")
		}
	}
	return ""
}

// ServesAPI reports whether this process runs the HTTP and gRPC servers.
func (c Config) ServesAPI() bool { return c.Role == RoleAPI || c.Role == RoleAll }

// RunsWorker reports whether this process runs background jobs.
func (c Config) RunsWorker() bool { return c.Role == RoleWorker || c.Role == RoleAll }

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

// envParser reads typed variables and collects the ones that do not parse,
// so Load reports all of them at once.
type envParser struct{ errs []error }

func (p *envParser) boolean(key string, def bool) bool {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		p.errs = append(p.errs, fmt.Errorf("%s=%q is not a boolean (use true/false, 1/0)", key, v))
		return def
	}
	return b
}

func (p *envParser) duration(key string, def time.Duration) time.Duration {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		p.errs = append(p.errs, fmt.Errorf("%s=%q is not a duration (use a unit, e.g. 15s or 2m)", key, v))
		return def
	}
	return d
}

func envList(key, def string) []string {
	raw := env(key, def)
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
