// Package config loads the cloud service configuration from the environment
// (12-factor). Every variable is documented in deploy/docker/cloud.dev.env.
package config

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"clarae/shared/envcompat"
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

	// MetricsNamespace is the Prometheus namespace of the service metrics. The collectors
	// are registered when the process starts, before Load runs, so internal/observability
	// reads it with MetricsNamespaceFromEnv; this is the same value, kept for logs and tests.
	MetricsNamespace string

	// LegacyNames reports that the issuer is the realm of a 1.x installation, so every
	// default that carries the product name is the one of 1.x (see nameDefaults).
	LegacyNames bool
	// Deprecations lists the settings read through a name that is going away, with the
	// name to use instead; the process logs them at start.
	Deprecations []string
}

// S3Config configures the object store.
type S3Config struct {
	Endpoint      string
	AccessKey     string
	SecretKey     string
	Region        string
	BucketBlobs   string
	BucketExports string
	// BucketBlobsDefaulted and BucketExportsDefaulted report that the name is the default
	// of nameDefaults, not an explicit S3_BUCKET_* setting: only a default can silently
	// point a 1.x installation at a new, empty bucket (see storage.S3Options.LegacyBucket).
	BucketBlobsDefaulted   bool
	BucketExportsDefaulted bool
	// LegacyBucketBlobs and LegacyBucketExports are the 1.x names of the buckets, set only when
	// the bucket is a default that differs from them: main passes them to storage.NewS3, which
	// refuses to start if the default bucket is missing and the 1.x one exists.
	LegacyBucketBlobs   string
	LegacyBucketExports string
	UsePathStyle        bool
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
	// AdminRoles are the realm roles that make a user an administrator (any of them is enough).
	AdminRoles []string
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
//
// The defaults that carry the product name (audience, OIDC clients, realm, buckets, metrics
// namespace) follow the issuer, see nameDefaults: an installation made for 1.x keeps its
// names without setting anything, a new one gets the new names. An explicit variable
// always wins.
func Load(role Role, version string) (Config, error) {
	var p envParser
	envDuration, envBool := p.duration, p.boolean
	issuer := env("OIDC_ISSUER", "")
	names := nameDefaults(issuer)
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
		LegacyNames:       names.legacy,
		S3: S3Config{
			Endpoint:       env("S3_ENDPOINT", ""),
			AccessKey:      env("S3_ACCESS_KEY", ""),
			SecretKey:      env("S3_SECRET_KEY", ""),
			Region:         env("S3_REGION", "us-east-1"),
			BucketBlobs:    env("S3_BUCKET_BLOBS", names.bucketBlobs),
			BucketExports:  env("S3_BUCKET_EXPORTS", names.bucketExports),
			UsePathStyle:   envBool("S3_USE_PATH_STYLE", true),
			PublicEndpoint: env("S3_PUBLIC_ENDPOINT", ""),
		},
		OIDC: OIDCConfig{
			Issuer:          issuer,
			Audience:        env("OIDC_AUDIENCE", names.audience),
			AllowedAZP:      envList("OIDC_ALLOWED_AZP", names.allowedAZP),
			AdminRoles:      envList("OIDC_ADMIN_ROLES", defaultAdminRoles),
			DesktopClientID: env("OIDC_DESKTOP_CLIENT_ID", names.desktopClient),
			WebClientID:     env("OIDC_WEB_CLIENT_ID", names.webClient),
			PublicGRPCAddr:  env("PUBLIC_GRPC_ADDR", env("GRPC_LISTEN_ADDR", "127.0.0.1:18082")),
			StatusCacheTTL:  envDuration("OIDC_STATUS_CACHE_TTL", 30*time.Second),
		},
		Keycloak: KeycloakConfig{
			BaseURL:      env("KC_ADMIN_BASE_URL", ""),
			Realm:        env("KC_REALM", names.realm),
			ClientID:     env("KC_ADMIN_CLIENT_ID", names.adminClient),
			ClientSecret: env("KC_ADMIN_CLIENT_SECRET", ""),
		},
	}
	c.S3.BucketBlobsDefaulted = env("S3_BUCKET_BLOBS", "") == ""
	c.S3.BucketExportsDefaulted = env("S3_BUCKET_EXPORTS", "") == ""
	if legacy := legacyFamily + "-blobs"; c.S3.BucketBlobsDefaulted && c.S3.BucketBlobs != legacy {
		c.S3.LegacyBucketBlobs = legacy
	}
	if legacy := legacyFamily + "-exports"; c.S3.BucketExportsDefaulted && c.S3.BucketExports != legacy {
		c.S3.LegacyBucketExports = legacy
	}
	c.MetricsNamespace = MetricsNamespaceFromEnv()

	// The escape hatch for the placeholder check below: never set it in production.
	allow, deprecated := envcompat.Lookup("ALLOW_PLACEHOLDER_SECRETS")
	allowName := envcompat.Prefix + "ALLOW_PLACEHOLDER_SECRETS"
	if deprecated {
		allowName = envcompat.LegacyPrefix + "ALLOW_PLACEHOLDER_SECRETS"
		c.Deprecations = append(c.Deprecations, allowName+" is deprecated, use "+envcompat.Prefix+
			"ALLOW_PLACEHOLDER_SECRETS (the old name is dropped in 3.0)")
	}
	c.AllowPlaceholderSecrets = p.boolValue(allowName, allow, false)

	proxies, err := parsePrefixes(envList("TRUSTED_PROXIES", ""))
	c.TrustedProxies = proxies
	return c, errors.Join(errors.Join(p.errs...), err, c.validate())
}

// The product name of 1.x, which the realm of an installation made for it still carries.
const legacyFamily = "memobrain"

// defaultAdminRoles are the realm roles of an administrator: the new one and the one of 1.x,
// so that a realm made for 1.x keeps working and a new realm is not forced to rename anything
// (dropped in 3.0, with the legacy names). internal/auth.DefaultAdminRoles is the same list.
const defaultAdminRoles = "clarae-admin,memobrain-admin"

// nameSet is the set of defaults that carry the product name.
type nameSet struct {
	realm, audience, allowedAZP, desktopClient, webClient, adminClient string
	bucketBlobs, bucketExports, metricsNamespace                       string
	// legacy: the names are the ones of 1.x.
	legacy bool
}

// nameDefaults returns the default names for an installation whose OIDC issuer is issuer.
// A realm called "memobrain" (issuer ending in /realms/memobrain) is an installation made
// for 1.x: its realm, clients, audience, buckets and metrics keep the 1.x names, because
// renaming them would invalidate every token, break the clients of 1.4.0 and hide the
// stored blobs. Any other issuer gets the new names (and the realm named by the issuer).
func nameDefaults(issuer string) nameSet {
	realm := issuerRealm(issuer)
	family := "clarae"
	if realm == legacyFamily {
		family = legacyFamily
	}
	if realm == "" {
		realm = family
	}
	return nameSet{
		realm:            realm,
		audience:         family + "-api",
		allowedAZP:       family + "-desktop," + family + "-web",
		desktopClient:    family + "-desktop",
		webClient:        family + "-web",
		adminClient:      family + "-admin-svc",
		bucketBlobs:      family + "-blobs",
		bucketExports:    family + "-exports",
		metricsNamespace: family,
		legacy:           family == legacyFamily,
	}
}

// issuerRealm returns the realm segment of a Keycloak issuer URL
// (https://host/realms/<realm>), or "" when the issuer has none.
func issuerRealm(issuer string) string {
	path := issuer
	if u, err := url.Parse(issuer); err == nil && u.Host != "" {
		path = u.Path
	}
	path = strings.TrimRight(path, "/")
	i := strings.LastIndex(path, "/realms/")
	if i < 0 {
		return ""
	}
	realm := path[i+len("/realms/"):]
	if strings.Contains(realm, "/") {
		return ""
	}
	return realm
}

var metricsNamespacePattern = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// MetricsNamespaceFromEnv returns the Prometheus namespace of the service metrics:
// METRICS_NAMESPACE when set, otherwise the name family of OIDC_ISSUER ("memobrain" for the
// realm of a 1.x installation, so that its dashboards and alerts keep working, else
// "clarae"). An invalid METRICS_NAMESPACE yields the family default here and an error from
// Load, which refuses to start with it.
//
// This is the one read of the environment outside Load, and it is deliberate: the collectors
// of internal/observability are package-level promauto variables, registered while the package
// initialises, before main can call Load.
func MetricsNamespaceFromEnv() string {
	if ns := os.Getenv("METRICS_NAMESPACE"); ns != "" && metricsNamespacePattern.MatchString(ns) {
		return ns
	}
	return nameDefaults(os.Getenv("OIDC_ISSUER")).metricsNamespace
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
	if ns := os.Getenv("METRICS_NAMESPACE"); ns != "" && !metricsNamespacePattern.MatchString(ns) {
		errs = append(errs, fmt.Errorf("METRICS_NAMESPACE=%q is not a Prometheus namespace (lowercase letters, digits and underscores, not starting with a digit)", ns))
	}
	if len(c.OIDC.AdminRoles) == 0 {
		errs = append(errs, errors.New("OIDC_ADMIN_ROLES must name at least one realm role"))
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
			"set real secrets (CLARAE_ALLOW_PLACEHOLDER_SECRETS=1 skips this check, for tests only)",
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
	return p.boolValue(key, os.Getenv(key), def)
}

// boolValue parses a boolean already read from the variable key (named in the error).
func (p *envParser) boolValue(key, v string, def bool) bool {
	if v == "" {
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
