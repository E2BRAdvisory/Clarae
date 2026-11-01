// Package httpserver assembles the HTTP API: router, middleware chain
// (request id, logging, recovery, rate limiting, CORS, compression, metrics,
// authentication) and the generated OpenAPI handlers.
package httpserver

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/admin"
	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/blobs"
	"memobrain/services/cloud/internal/configprofiles"
	"memobrain/services/cloud/internal/export"
	"memobrain/services/cloud/internal/groups"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/observability"
	"memobrain/services/cloud/internal/privacy"
	"memobrain/services/cloud/internal/quota"
	"memobrain/services/cloud/internal/revisions"
	"memobrain/services/cloud/internal/sharing"
	"memobrain/services/cloud/internal/sync"
	"memobrain/services/cloud/internal/system"
	"memobrain/services/cloud/internal/users"
	"memobrain/services/cloud/internal/vaults"
	"memobrain/shared/syncproto"
)

// BasePath is where the REST API is mounted (§3.1).
const BasePath = "/api/v1"

// Deps are the module handlers composed into the API.
type Deps struct {
	Logger    zerolog.Logger
	Auth      *auth.Middleware
	System    *system.HTTP
	Users     *users.HTTP
	Config    *configprofiles.HTTP
	Vaults    *vaults.HTTP
	Blobs     *blobs.HTTP
	Sync      *sync.HTTP
	Revisions *revisions.HTTP
	Quota     *quota.HTTP
	Groups    *groups.HTTP
	Sharing   *sharing.HTTP
	Admin     *admin.HTTP
	Export    *export.HTTP
	Privacy   *privacy.HTTP
	// Tus serves resumable uploads; Events serves the SSE stream. Both live
	// outside the generated router and are optional (nil in unit tests).
	Tus    *blobs.TusHandler
	Events http.Handler
	// WebUI serves the embedded SPA for every path the API does not own
	// (nil: plain 404).
	WebUI       http.Handler
	WebUIOrigin string
	// TrustedProxies are the reverse proxies whose X-Forwarded-For is believed
	// when resolving the client address for the per-IP rate limit and the
	// audit log.
	TrustedProxies []netip.Prefix
	Metrics        *observability.Metrics
	// Drain, when set, ends the SSE streams at shutdown (see Drain).
	Drain *Drain
}

// handlers composes every module's strict handlers into the single
// StrictServerInterface the generated router expects. Go embedding merges
// the methods; a name clash is a compile error, which is what we want.
// Aliases give each embedded field a distinct name (embedding three types
// called HTTP would clash).
type (
	systemHTTP    = system.HTTP
	usersHTTP     = users.HTTP
	configHTTP    = configprofiles.HTTP
	vaultsHTTP    = vaults.HTTP
	blobsHTTP     = blobs.HTTP
	syncHTTP      = sync.HTTP
	revisionsHTTP = revisions.HTTP
	quotaHTTP     = quota.HTTP
	groupsHTTP    = groups.HTTP
	sharingHTTP   = sharing.HTTP
	adminHTTP     = admin.HTTP
	exportHTTP    = export.HTTP
	privacyHTTP   = privacy.HTTP
)

type handlers struct {
	*systemHTTP
	*usersHTTP
	*configHTTP
	*vaultsHTTP
	*blobsHTTP
	*syncHTTP
	*revisionsHTTP
	*quotaHTTP
	*groupsHTTP
	*sharingHTTP
	*adminHTTP
	*exportHTTP
	*privacyHTTP
}

var _ api.StrictServerInterface = handlers{}

// NewRouter builds the complete router.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	// No RealIP middleware: trusting X-Forwarded-For blindly enables spoofing.
	// The rate limiter resolves the client through the trusted proxies only.
	r.Use(SecurityHeaders)
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
	clientIP := NewClientIP(d.TrustedProxies)
	r.Use(NewRateLimiter(50, 100).ByIP(clientIP))
	r.Use(AuditClientIP(clientIP))
	r.Use(probeDetails)

	r.Handle("/metrics", internalOnly(promhttp.Handler()))

	// Routes outside the OpenAPI contract: tus (own protocol) and SSE (streaming).
	if d.Tus != nil {
		r.Group(func(r chi.Router) {
			r.Use(d.Auth.Protect)
			d.Tus.Mount(r, BasePath)
		})
	}
	if d.Events != nil {
		events := d.Events
		if d.Drain != nil {
			events = d.Drain.Streams(events)
		}
		r.With(d.Auth.Protect).Method(http.MethodGet, BasePath+"/events", events)
	}

	strict := api.NewStrictHandlerWithOptions(
		handlers{d.System, d.Users, d.Config, d.Vaults, d.Blobs, d.Sync, d.Revisions, d.Quota, d.Groups, d.Sharing, d.Admin, d.Export, d.Privacy},
		nil,
		api.StrictHTTPServerOptions{
			RequestErrorHandlerFunc: writeRequestError,
			ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
				handleHandlerError(w, r, err)
			},
		},
	)
	api.HandlerWithOptions(strict, api.ChiServerOptions{
		BaseURL:    BasePath,
		BaseRouter: r,
		// Applied innermost-first: the last entry runs first, so the limits
		// cover the whole operation and auth precedes validation.
		Middlewares: []api.MiddlewareFunc{requestValidator(), d.Auth.Handler, apiLimits},
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			httpproblem.Write(w, r, syncproto.CodeValidationFailed, err.Error(), nil)
		},
	})

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, BasePath) {
			httpproblem.Write(w, r, syncproto.CodeNotFound, "no such endpoint", nil)
			return
		}
		if d.WebUI != nil {
			d.WebUI.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
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
