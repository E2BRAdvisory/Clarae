// Command nodus-cloud is the Nodus Cloud Service binary. The same binary runs
// as API server, background worker, or both, selected with --role.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/sync/errgroup"

	"nodus/services/cloud/internal/auth"
	"nodus/services/cloud/internal/config"
	"nodus/services/cloud/internal/configprofiles"
	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/grpcserver"
	"nodus/services/cloud/internal/httpserver"
	"nodus/services/cloud/internal/observability"
	"nodus/services/cloud/internal/system"
	"nodus/services/cloud/internal/users"
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
		fmt.Fprintln(os.Stderr, "nodus-cloud:", err)
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
	if cfg.ServesAPI() {
		if err := database.Migrate(ctx); err != nil {
			return err
		}
		logger.Info().Msg("database migrated")
	}

	g, ctx := errgroup.WithContext(ctx)

	if cfg.ServesAPI() {
		verifier, err := connectOIDC(ctx, logger, cfg)
		if err != nil {
			return err
		}
		userSvc := users.NewService(database)
		authn := auth.NewMiddleware(verifier, userSvc, httpserver.NewRateLimiter(20, 60), cfg.OIDC.StatusCacheTTL)

		router := httpserver.NewRouter(httpserver.Deps{
			Logger: logger,
			Auth:   authn,
			System: system.NewHTTP(Version, system.ClientConfig{
				Issuer:          cfg.OIDC.Issuer,
				DesktopClientID: cfg.OIDC.DesktopClientID,
				Audience:        cfg.OIDC.Audience,
				GRPCEndpoint:    cfg.OIDC.PublicGRPCAddr,
			}, system.CheckerFunc{N: "database", F: database.Ping}),
			Users:       users.NewHTTP(userSvc),
			Config:      configprofiles.NewHTTP(),
			WebUIOrigin: cfg.WebUIOrigin,
			Metrics:     observability.New(),
		})
		httpSrv := httpserver.NewServer(cfg.ListenAddr, router)
		g.Go(func() error {
			logger.Info().Str("addr", cfg.ListenAddr).Msg("http listening")
			if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				return fmt.Errorf("http: %w", err)
			}
			return nil
		})
		g.Go(func() error {
			<-ctx.Done()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
			defer cancel()
			return httpSrv.Shutdown(shutdownCtx)
		})

		grpcSrv := grpcserver.New(authn)
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
			logger.Info().Msg("worker ready (no jobs scheduled before M2)")
			<-ctx.Done()
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
