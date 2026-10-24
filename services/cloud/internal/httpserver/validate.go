package httpserver

import (
	"context"
	"fmt"
	"net/http"

	"github.com/getkin/kin-openapi/openapi3filter"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"nodus/services/cloud/internal/api"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
)

// requestValidator validates every request (parameters, headers, JSON body)
// against the embedded OpenAPI document (§3.7: input validated by schema).
// Authentication is handled by the auth middleware, which runs first, so the
// validator's own authentication hook is a no-op.
func requestValidator() api.MiddlewareFunc {
	spec, err := api.GetSwagger()
	if err != nil {
		panic(fmt.Sprintf("embedded openapi spec: %v", err))
	}
	return nethttpmiddleware.OapiRequestValidatorWithOptions(spec, &nethttpmiddleware.Options{
		Options: openapi3filter.Options{
			AuthenticationFunc: func(context.Context, *openapi3filter.AuthenticationInput) error { return nil },
		},
		SilenceServersWarning: true,
		ErrorHandlerWithOpts: func(_ context.Context, err error, w http.ResponseWriter, r *http.Request, _ nethttpmiddleware.ErrorHandlerOpts) {
			httpproblem.Write(w, r, syncproto.CodeValidationFailed, err.Error(), nil)
		},
	})
}
