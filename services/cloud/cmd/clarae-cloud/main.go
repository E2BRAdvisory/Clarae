// Command clarae-cloud is the Clarae notanda Cloud Service binary. The same binary runs
// as API server, background worker, or both, selected with --role.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog"
	"golang.org/x/sync/errgroup"

	"clarae/services/cloud/internal/app"
	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/config"
	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/grpcserver"
	"clarae/services/cloud/internal/httpserver"
	"clarae/services/cloud/internal/keycloak"
	"clarae/services/cloud/internal/observability"

	"clarae/services/cloud/internal/storage"
	"clarae/services/cloud/internal/system"
	webembed "clarae/services/cloud/web-embed"
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
		fmt.Fprintln(os.Stderr, "clarae-cloud:", err)
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

	signalled, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// The group's context ends on the signal, when a component fails, or with
	// abort when the startup fails after the API listener opened.
	ctx, abort := context.WithCancel(signalled)
	defer abort()
	g, ctx := errgroup.WithContext(ctx)

	// The API listener opens first: the migrations may wait up to 10 minutes
	// for another replica's migration lock and the OIDC discovery retries for
	// about a minute (up to 6 if the issuer hangs), longer than the startup
	// probe waits for a first answer.
	// Until the API is wired /healthz answers 200 and /readyz 503 (Startup).
	var (
		startup *httpserver.Startup
		drain   *httpserver.Drain
	)
	if cfg.ServesAPI() {
		startup = httpserver.NewStartup(Version, promhttp.Handler())
		drain = httpserver.NewDrain()
		httpSrv := httpserver.NewServer(cfg.ListenAddr, startup)
		g.Go(func() error {
			logger.Info().Str("addr", cfg.ListenAddr).Msg("http listening")
			// Readiness fails on the signal, the server keeps serving for the drain
			// delay, then in-flight requests finish within the shutdown timeout.
			if err := httpserver.Serve(ctx, httpSrv, drain, cfg.ShutdownDrain, cfg.ShutdownTimeout); err != nil {
				return fmt.Errorf("http: %w", err)
			}
			return nil
		})
	}
	// fail stops what already runs and reports why the startup failed: the
	// listener's own error first (a port in use cancels the startup), nothing
	// when the signal interrupted it.
	fail := func(err error) error {
		abort()
		if gerr := g.Wait(); gerr != nil {
			return gerr
		}
		if signalled.Err() != nil {
			logger.Info().Msg("stopped during startup")
			return nil
		}
		return err
	}

	database, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fail(err)
	}
	defer database.Close()
	observability.RegisterPool(prometheus.DefaultRegisterer, database.Pool)
	if cfg.ServesAPI() {
		if err := database.Migrate(ctx); err != nil {
			return fail(err)
		}
		logger.Info().Msg("database migrated")
	}

	sweepSpool(os.TempDir(), time.Now(), logger)

	store, err := openStore(ctx, cfg)
	if err != nil {
		return fail(err)
	}
	application := app.New(database, store, logger)
	if cfg.S3.Endpoint != "" {
		exportStore, err := storage.NewS3(ctx, storage.S3Options{
			Endpoint: cfg.S3.Endpoint, AccessKey: cfg.S3.AccessKey, SecretKey: cfg.S3.SecretKey, Region: cfg.S3.Region,
			Bucket: cfg.S3.BucketExports, UsePathStyle: cfg.S3.UsePathStyle, PublicEndpoint: cfg.S3.PublicEndpoint,
		})
		if err != nil {
			return fail(err)
		}
		application.ExportStore = exportStore
	}
	application.Keycloak = keycloak.New(keycloak.Config{
		BaseURL: cfg.Keycloak.BaseURL, Realm: cfg.Keycloak.Realm, ClientID: cfg.Keycloak.ClientID, ClientSecret: cfg.Keycloak.ClientSecret,
	})

	if cfg.ServesAPI() {
		verifier, err := connectOIDC(ctx, logger, cfg)
		if err != nil {
			return fail(err)
		}
		authn := auth.NewMiddleware(verifier, application.Users, httpserver.NewRateLimiter(20, 60), cfg.OIDC.StatusCacheTTL)
		if len(cfg.TrustedProxies) == 0 {
			// Behind a reverse proxy every request comes from the proxy's address,
			// so the per-IP rate limit would become one bucket for all users.
			logger.Warn().Msg("TRUSTED_PROXIES is empty: if the API is behind a reverse proxy or ingress, all clients share one rate-limit bucket")
		}

		// A client opens one stream and reopens it when its token expires or the
		// connection drops (with backoff): the per-user budget bounds the replays
		// a misbehaving client can cause, the per-IP one the anonymous attempts.
		grpcSrv := grpcserver.New(authn, application.Hub, grpcserver.WithLogger(logger), grpcserver.WithRateLimits(grpcserver.RateLimits{
			PerIP:    httpserver.NewRateLimiter(10, 100),
			PerUser:  httpserver.NewRateLimiter(1, 10),
			ClientIP: httpserver.NewClientIP(cfg.TrustedProxies),
		}))
		lis, err := net.Listen("tcp", cfg.GRPCListenAddr)
		if err != nil {
			return fail(fmt.Errorf("grpc listen: %w", err))
		}
		router := httpserver.NewRouter(application.FillDeps(httpserver.Deps{
			Logger: logger,
			Auth:   authn,
			System: system.NewHTTP(Version, system.ClientConfig{
				Issuer:          cfg.OIDC.Issuer,
				DesktopClientID: cfg.OIDC.DesktopClientID,
				WebClientID:     cfg.OIDC.WebClientID,
				Audience:        cfg.OIDC.Audience,
				GRPCEndpoint:    cfg.OIDC.PublicGRPCAddr,
			}, system.CheckerFunc{N: "database", F: database.Ping}, system.CheckerFunc{N: "storage", F: store.Ping},
				system.CheckerFunc{N: "shutdown", F: drain.Check, Live: true}).WithLogger(logger),
			WebUI:          webembed.Handler(webembed.Options{Issuer: cfg.OIDC.Issuer}),
			WebUIOrigin:    cfg.WebUIOrigin,
			TrustedProxies: cfg.TrustedProxies,
			Metrics:        observability.New(),
			Drain:          drain,
		}))

		// The notifications keep flowing while the endpoint drains: the hub
		// stops with the streams, at the end of the drain delay.
		hubCtx, stopHub := context.WithCancel(context.WithoutCancel(ctx))
		g.Go(func() error {
			defer stopHub()
			go func() { <-drain.Closed(); stopHub() }()
			return application.Hub.Run(hubCtx)
		})
		g.Go(func() error {
			logger.Info().Str("addr", cfg.GRPCListenAddr).Msg("grpc listening")
			return grpcSrv.Serve(lis)
		})
		g.Go(func() error {
			<-ctx.Done()
			// The same two phases as HTTP: the streams stay open while readiness
			// fails and the endpoint leaves the load balancer, then they end
			// (clients reconnect to another replica and replay) and the server
			// stops within the shutdown timeout.
			<-drain.Closed()
			grpcSrv.Shutdown(cfg.ShutdownTimeout)
			return nil
		})
		startup.Ready(router)
		logger.Info().Msg("api ready")
	}

	if cfg.RunsWorker() {
		runner := application.Jobs()
		health := &workerHealth{lastTick: runner.LastTick, heartbeat: runner.Heartbeat(), now: time.Now}
		dedicated := cfg.Role == config.RoleWorker
		if dedicated {
			// Without the API listener the worker needs its own, for Prometheus
			// (the job metrics live in this process) and the orchestrator's probes.
			health.waiting.Store(true)
			srv := &http.Server{Addr: cfg.MetricsListenAddr, Handler: workerHandler(health, Version), ReadHeaderTimeout: 10 * time.Second}
			g.Go(func() error {
				logger.Info().Str("addr", cfg.MetricsListenAddr).Msg("worker metrics and health listening")
				if err := serveInternal(ctx, srv, cfg.ShutdownTimeout); err != nil {
					return fmt.Errorf("worker http: %w", err)
				}
				return nil
			})
		}
		g.Go(func() error {
			if dedicated {
				// Only the API migrates: the jobs must not run on a schema older
				// than this binary expects (the worker may start first).
				err := database.WaitForSchema(ctx, time.Second, 30*time.Second, func(err error, next time.Duration) {
					logger.Warn().Err(err).Dur("retry_in", next).Msg("waiting for the API to migrate the database schema")
				})
				if err != nil {
					if ctx.Err() != nil {
						return nil
					}
					return err
				}
				health.waiting.Store(false)
			}
			logger.Info().Msg("worker started")
			runner.Run(ctx)
			return nil
		})
	}

	err = g.Wait()
	logger.Info().Msg("stopped")
	return err
}

// connectOIDC retries discovery so the service survives starting before the
// identity provider is ready (compose, Kubernetes rollouts). Each attempt is
// bounded: the probes no longer restart a slow startup, so an issuer that
// accepts connections without answering must not hang it forever.
func connectOIDC(ctx context.Context, logger zerolog.Logger, cfg config.Config) (*auth.Verifier, error) {
	const (
		attempts = 30
		timeout  = 10 * time.Second
	)
	for i := 1; ; i++ {
		// go-oidc keeps no cancellation from this context: the key set fetched
		// later uses its own.
		actx, cancel := context.WithTimeout(ctx, timeout)
		v, err := auth.NewVerifier(actx, cfg.OIDC.Issuer, cfg.OIDC.Audience, cfg.OIDC.AllowedAZP)
		cancel()
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
