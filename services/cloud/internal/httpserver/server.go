// Package httpserver assembles the HTTP API: router, middleware chain
// (request id, logging, recovery, rate limiting, CORS, compression, metrics,
// authentication) and the generated OpenAPI handlers.
package httpserver

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog"

	"nodus/services/cloud/internal/api"
	"nodus/services/cloud/internal/auth"
	"nodus/services/cloud/internal/configprofiles"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/services/cloud/internal/observability"
	"nodus/services/cloud/internal/system"
	"nodus/services/cloud/internal/users"
	"nodus/shared/syncproto"
)

// BasePath is where the REST API is mounted (§3.1).
const BasePath = "/api/v1"

// Deps are the module handlers composed into the API.
type Deps struct {
	Logger      zerolog.Logger
	Auth        *auth.Middleware
	System      *system.HTTP
	Users       *users.HTTP
	Config      *configprofiles.HTTP
	WebUIOrigin string
	Metrics     *observability.Metrics
}

// handlers composes every module's strict handlers into the single
// StrictServerInterface the generated router expects. Go embedding merges
// the methods; a name clash is a compile error, which is what we want.
// Aliases give each embedded field a distinct name (embedding three types
// called HTTP would clash).
type (
	systemHTTP = system.HTTP
	usersHTTP  = users.HTTP
	configHTTP = configprofiles.HTTP
)

type handlers struct {
	*systemHTTP
	*usersHTTP
	*configHTTP
}

var _ api.StrictServerInterface = handlers{}

// NewRouter builds the complete router.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	// No RealIP middleware: trusting X-Forwarded-For blindly enables spoofing.
	// Behind the ingress, r.RemoteAddr is the proxy; a trusted-proxy aware
	// resolver is added with the deployment work (M7).
	r.Use(RequestLogger(d.Logger))
	r.Use(Recoverer)
	if d.Metrics != nil {
		r.Use(d.Metrics.HTTPMiddleware)
	}
	r.Use(middleware.Compress(5, "application/json", "application/problem+json"))
	if d.WebUIOrigin != "" {
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins:   []string{d.WebUIOrigin},
			AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
			AllowedHeaders:   []string{"Authorization", "Content-Type", "If-Match", "If-None-Match", "Idempotency-Key", "X-Request-Id"},
			ExposedHeaders:   []string{"ETag", "RateLimit-Limit", "RateLimit-Remaining", "Retry-After", "X-Request-Id"},
			AllowCredentials: false,
			MaxAge:           600,
		}))
	}
	r.Use(NewRateLimiter(50, 100).ByIP)
	r.Use(middleware.Timeout(60 * time.Second))

	r.Handle("/metrics", promhttp.Handler())

	strict := api.NewStrictHandlerWithOptions(
		handlers{d.System, d.Users, d.Config},
		nil,
		api.StrictHTTPServerOptions{
			RequestErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
				httpproblem.Write(w, r, syncproto.CodeValidationFailed, err.Error(), nil)
			},
			ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
				handleHandlerError(w, r, err)
			},
		},
	)
	api.HandlerWithOptions(strict, api.ChiServerOptions{
		BaseURL:    BasePath,
		BaseRouter: r,
		// Applied innermost-first: the last entry runs first, so auth precedes validation.
		Middlewares: []api.MiddlewareFunc{requestValidator(), d.Auth.Handler},
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			httpproblem.Write(w, r, syncproto.CodeValidationFailed, err.Error(), nil)
		},
	})

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, BasePath) {
			httpproblem.Write(w, r, syncproto.CodeNotFound, "no such endpoint", nil)
			return
		}
		http.NotFound(w, r) // Web UI SPA fallback is mounted here in M4
	})
	return r
}

// handleHandlerError maps errors returned by strict handlers to problems.
// Modules return *Error (or wrap one) to choose the code; anything else is 500.
func handleHandlerError(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *httpproblem.Error
	if errors.As(err, &apiErr) {
		httpproblem.Write(w, r, apiErr.Code, apiErr.Detail, apiErr.Extra)
		return
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		httpproblem.Write(w, r, syncproto.CodeInternal, "request cancelled", nil)
		return
	}
	zerolog.Ctx(r.Context()).Error().Err(err).Msg("handler error")
	httpproblem.Write(w, r, syncproto.CodeInternal, "", nil)
}

// NewServer returns an http.Server with production timeouts.
func NewServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute, // blob uploads
		WriteTimeout:      0,               // streaming responses (SSE, exports) manage their own deadlines
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}
