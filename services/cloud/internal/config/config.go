// Package config loads the cloud service configuration from the environment
// (12-factor). Every variable is documented in deploy/docker/cloud.dev.env.
package config

import (
	"errors"
	"fmt"
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
	WebUIOrigin    string
	LogLevel       string

	DatabaseURL string

	S3 S3Config

	// StorageDir stores blobs on the local filesystem when S3_ENDPOINT is
	// empty (single-node development and tests).
	StorageDir string

	OIDC OIDCConfig

	Keycloak KeycloakConfig

	// Shutdown bounds graceful shutdown.
	ShutdownTimeout time.Duration
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

// Load reads the configuration from the environment and validates it.
func Load(role Role, version string) (Config, error) {
	c := Config{
		Role:            role,
		Version:         version,
		ListenAddr:      env("LISTEN_ADDR", "127.0.0.1:18081"),
		GRPCListenAddr:  env("GRPC_LISTEN_ADDR", "127.0.0.1:18082"),
		WebUIOrigin:     env("WEB_UI_ORIGIN", ""),
		LogLevel:        env("LOG_LEVEL", "info"),
		DatabaseURL:     env("DATABASE_URL", ""),
		ShutdownTimeout: envDuration("SHUTDOWN_TIMEOUT", 15*time.Second),
		StorageDir:      env("STORAGE_DIR", ""),
		S3: S3Config{
			Endpoint:      env("S3_ENDPOINT", ""),
			AccessKey:     env("S3_ACCESS_KEY", ""),
			SecretKey:     env("S3_SECRET_KEY", ""),
			Region:        env("S3_REGION", "us-east-1"),
			BucketBlobs:   env("S3_BUCKET_BLOBS", "nodus-blobs"),
			BucketExports: env("S3_BUCKET_EXPORTS", "nodus-exports"),
			UsePathStyle:  envBool("S3_USE_PATH_STYLE", true),
		},
		OIDC: OIDCConfig{
			Issuer:          env("OIDC_ISSUER", ""),
			Audience:        env("OIDC_AUDIENCE", "nodus-api"),
			AllowedAZP:      envList("OIDC_ALLOWED_AZP", "nodus-desktop,nodus-web"),
			DesktopClientID: env("OIDC_DESKTOP_CLIENT_ID", "nodus-desktop"),
			PublicGRPCAddr:  env("PUBLIC_GRPC_ADDR", env("GRPC_LISTEN_ADDR", "127.0.0.1:18082")),
			StatusCacheTTL:  envDuration("OIDC_STATUS_CACHE_TTL", 30*time.Second),
		},
		Keycloak: KeycloakConfig{
			BaseURL:      env("KC_ADMIN_BASE_URL", ""),
			Realm:        env("KC_REALM", "nodus"),
			ClientID:     env("KC_ADMIN_CLIENT_ID", "nodus-admin-svc"),
			ClientSecret: env("KC_ADMIN_CLIENT_SECRET", ""),
		},
	}
	return c, c.validate()
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
	return errors.Join(errs...)
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

func envBool(key string, def bool) bool {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envDuration(key string, def time.Duration) time.Duration {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
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
