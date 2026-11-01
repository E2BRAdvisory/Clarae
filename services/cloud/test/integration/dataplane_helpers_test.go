//go:build integration

package integration

import (
	"encoding/json"
	"net/http"
	"testing"

	"memobrain/shared/syncproto"
)

// respProblem decodes the problem document of an error response.
func respProblem(t *testing.T, resp *http.Response) syncproto.Problem {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	var p syncproto.Problem
	if err := json.NewDecoder(resp.Body).Decode(&p); err != nil {
		t.Fatalf("status %d: not a problem document: %v", resp.StatusCode, err)
	}
	return p
}
