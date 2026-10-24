package app

import (
	"context"

	"nodus/apps/desktop/internal/graph"
)

// The graph view keeps its per-vault settings in .nodus/graph.json.
func init() { vaultConfigFiles["graph.json"] = true }

// GraphAPI exposes the data of the Graph view (§2.5 "graph"). Layout and
// rendering live in the frontend.
type GraphAPI struct{ app *App }

// NewGraphAPI binds the API.
func NewGraphAPI(a *App) *GraphAPI { return &GraphAPI{app: a} }

// Build returns the nodes and edges of a vault (or, with options.center, of the
// neighbourhood of one file) from the local index. A malformed query or group
// query returns an error whose message starts with "query:".
func (g *GraphAPI) Build(vaultID string, options graph.Options) (graph.Graph, error) {
	ov, err := g.app.vault(vaultID)
	if err != nil {
		return graph.Graph{}, err
	}
	return graph.Build(context.Background(), ov.Indexer.DB(), options)
}
