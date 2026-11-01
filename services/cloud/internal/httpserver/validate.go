package httpserver

import (
	"context"
	"fmt"
	"net/http"

	"github.com/getkin/kin-openapi/openapi3filter"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"memobrain/services/cloud/internal/api"
)

// requestValidator validates every request (parameters, headers, JSON body)
// against the embedded OpenAPI document (§3.7: input validated by schema).
// Authentication is handled by the auth middleware, which runs first, so the
// validator's own authentication hook is a no-op.
//
// Byte-stream operations (isStreaming: blob upload, downloads) are validated
// without their body: openapi3filter reads a body fully into memory, both to
// decode it and before running the security requirements, so a PUT blob of
// tens of MB would be buffered (twice) before the blob module's own size cap
// runs. The body is hidden from the validator and handed back to the
// operation, which bounds it while streaming; parameters are still checked.
func requestValidator() api.MiddlewareFunc {
	spec, err := api.GetSwagger()
	if err != nil {
		panic(fmt.Sprintf("embedded openapi spec: %v", err))
	}
	newValidator := func(excludeBody bool) api.MiddlewareFunc {
		return nethttpmiddleware.OapiRequestValidatorWithOptions(spec, &nethttpmiddleware.Options{
			Options: openapi3filter.Options{
				AuthenticationFunc: func(context.Context, *openapi3filter.AuthenticationInput) error { return nil },
				ExcludeRequestBody: excludeBody,
			},
			SilenceServersWarning: true,
			ErrorHandlerWithOpts: func(_ context.Context, err error, w http.ResponseWriter, r *http.Request, _ nethttpmiddleware.ErrorHandlerOpts) {
				writeRequestError(w, r, err)
			},
		})
	}
	full, withoutBody := newValidator(false), newValidator(true)
	return func(next http.Handler) http.Handler {
		f := full(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isStreaming(r.URL.Path) {
				f.ServeHTTP(w, r)
				return
			}
			body := r.Body
			r.Body = http.NoBody
			withoutBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.Body = body
				next.ServeHTTP(w, r)
			})).ServeHTTP(w, r)
		})
	}
}
