// Command memobrain-cloud is the MemoBrain Notes Cloud Service binary. The same binary runs
// as API server, background worker, or both, selected with --role.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/rs/zerolog"
	"golang.org/x/sync/errgroup"

	"memobrain/services/cloud/internal/app"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/config"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/grpcserver"
	"memobrain/services/cloud/internal/httpserver"
	"memobrain/services/cloud/internal/keycloak"
	"memobrain/services/cloud/internal/observability"

	"memobrain/services/cloud/internal/storage"
	"memobrain/services/cloud/internal/system"
	webembed "memobrain/services/cloud/web-embed"
)

// Version is set at build time via -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	role := flag.String("role", "all", "process role: api | worker | all")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(Version)
		return
	}
	if err := run(config.Role(*role)); err != nil {
		fmt.Fprintln(os.Stderr, "memobrain-cloud:", err)
		os.Exit(1)
	}
}

func run(role config.Role) error {
	cfg, err := config.Load(role, Version)
	if err != nil {
		return err
	}
	logger := newLogger(cfg.LogLevel)
	logger.Info().Str("version", Version).Str("role", string(cfg.Role)).Msg("starting")

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	observability.RegisterPool(prometheus.DefaultRegisterer, database.Pool)
	if cfg.ServesAPI() {
		if err := database.Migrate(ctx); err != nil {
			return err
		}
		logger.Info().Msg("database migrated")
	}

	store, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	application := app.New(database, store, logger)
	if cfg.S3.Endpoint != "" {
		exportStore, err := storage.NewS3(ctx, storage.S3Options{
			Endpoint: cfg.S3.Endpoint, AccessKey: cfg.S3.AccessKey, SecretKey: cfg.S3.SecretKey, Region: cfg.S3.Region,
			Bucket: cfg.S3.BucketExports, UsePathStyle: cfg.S3.UsePathStyle, PublicEndpoint: cfg.S3.PublicEndpoint,
		})
		if err != nil {
			return err
		}
		application.ExportStore = exportStore
	}
	application.Keycloak = keycloak.New(keycloak.Config{
		BaseURL: cfg.Keycloak.BaseURL, Realm: cfg.Keycloak.Realm, ClientID: cfg.Keycloak.ClientID, ClientSecret: cfg.Keycloak.ClientSecret,
	})

	g, ctx := errgroup.WithContext(ctx)

	if cfg.ServesAPI() {
		verifier, err := connectOIDC(ctx, logger, cfg)
		if err != nil {
			return err
		}
		authn := auth.NewMiddleware(verifier, application.Users, httpserver.NewRateLimiter(20, 60), cfg.OIDC.StatusCacheTTL)

		drain := httpserver.NewDrain()
		router := httpserver.NewRouter(application.FillDeps(httpserver.Deps{
			Logger: logger,
			Auth:   authn,
			System: system.NewHTTP(Version, system.ClientConfig{
				Issuer:          cfg.OIDC.Issuer,
				DesktopClientID: cfg.OIDC.DesktopClientID,
				WebClientID:     cfg.OIDC.WebClientID,
				Audience:        cfg.OIDC.Audience,
				GRPCEndpoint:    cfg.OIDC.PublicGRPCAddr,
			}, system.CheckerFunc{N: "database", F: database.Ping}, system.CheckerFunc{N: "storage", F: store.Ping}, system.CheckerFunc{N: "shutdown", F: drain.Check}),
			WebUI:       webembed.Handler(webembed.Options{Issuer: cfg.OIDC.Issuer}),
			WebUIOrigin: cfg.WebUIOrigin,
			Metrics:     observability.New(),
			Drain:       drain,
		}))
		httpSrv := httpserver.NewServer(cfg.ListenAddr, router)
		g.Go(func() error {
			logger.Info().Str("addr", cfg.ListenAddr).Msg("http listening")
			// Readiness fails on the signal, the server keeps serving for the drain
			// delay, then in-flight requests finish within the shutdown timeout.
			if err := httpserver.Serve(ctx, httpSrv, drain, cfg.ShutdownDrain, cfg.ShutdownTimeout); err != nil {
				return fmt.Errorf("http: %w", err)
			}
			return nil
		})

		g.Go(func() error { return application.Hub.Run(ctx) })
		grpcSrv := grpcserver.New(authn, application.Hub)
		lis, err := net.Listen("tcp", cfg.GRPCListenAddr)
		if err != nil {
			return fmt.Errorf("grpc listen: %w", err)
		}
		g.Go(func() error {
			logger.Info().Str("addr", cfg.GRPCListenAddr).Msg("grpc listening")
			return grpcSrv.Serve(lis)
		})
		g.Go(func() error {
			<-ctx.Done()
			done := make(chan struct{})
			go func() { grpcSrv.GracefulStop(); close(done) }()
			select {
			case <-done:
			case <-time.After(cfg.ShutdownTimeout):
				grpcSrv.Stop()
			}
			return nil
		})
	}

	if cfg.RunsWorker() {
		g.Go(func() error {
			logger.Info().Msg("worker started")
			application.Jobs().Run(ctx)
			return nil
		})
	}

	err = g.Wait()
	logger.Info().Msg("stopped")
	return err
}

// connectOIDC retries discovery so the service survives starting before the
// identity provider is ready (compose, Kubernetes rollouts).
func connectOIDC(ctx context.Context, logger zerolog.Logger, cfg config.Config) (*auth.Verifier, error) {
	const attempts = 30
	for i := 1; ; i++ {
		v, err := auth.NewVerifier(ctx, cfg.OIDC.Issuer, cfg.OIDC.Audience, cfg.OIDC.AllowedAZP)
		if err == nil {
			logger.Info().Str("issuer", cfg.OIDC.Issuer).Msg("oidc issuer ready")
			return v, nil
		}
		if i >= attempts {
			return nil, err
		}
		logger.Warn().Err(err).Int("attempt", i).Msg("oidc discovery failed, retrying")
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

func newLogger(level string) zerolog.Logger {
	lvl, err := zerolog.ParseLevel(level)
	if err != nil {
		lvl = zerolog.InfoLevel
	}
	zerolog.TimeFieldFormat = time.RFC3339Nano
	return zerolog.New(os.Stdout).Level(lvl).With().Timestamp().Logger()
}

// openStore selects the blob store: S3-compatible when configured, otherwise a
// local directory.
func openStore(ctx context.Context, cfg config.Config) (storage.BlobStore, error) {
	if cfg.S3.Endpoint != "" {
		return storage.NewS3(ctx, storage.S3Options{
			Endpoint: cfg.S3.Endpoint, AccessKey: cfg.S3.AccessKey, SecretKey: cfg.S3.SecretKey,
			Region: cfg.S3.Region, Bucket: cfg.S3.BucketBlobs, UsePathStyle: cfg.S3.UsePathStyle,
		})
	}
	return storage.NewFS(cfg.StorageDir)
}
