package app

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"regexp"
	"time"

	"clarae/apps/desktop/internal/vault"

	"github.com/rs/zerolog"
)

// drawingCacheMinAge is how old a cached preview must be before it can be pruned: one written
// for a drawing the index has not seen yet (a save just made, the watcher batch still in flight)
// is not an orphan.
const drawingCacheMinAge = 10 * time.Minute

// previewFileRe is the name of a cached preview: "<hash>.svg" or "<hash>.dark.svg". The hash is
// group 1. Any other name in the folder is not ours and is left alone.
var previewFileRe = regexp.MustCompile(`^([0-9a-f]{64})(?:\.dark)?\.svg$`)

// pruneDrawingCache removes from .clarae/cache/drawings/ the previews whose hash is not the
// current hash of any drawing in the index and that are older than drawingCacheMinAge at now. Every save of a
// drawing leaves the preview of its previous content behind, so without this the folder only
// grows. It is best effort (the cache is derived and local): a file that cannot be removed stays,
// and the count of removed files comes with the first error met. A folder that does not exist
// (nothing was ever cached) is not an error. The index must already be reconciled with the disk.
func pruneDrawingCache(ctx context.Context, fsys *vault.FS, db *sql.DB, now time.Time) (int, error) {
	files, err := fsys.ListFiles(drawingCacheDir)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var candidates []vault.Entry
	for _, e := range files {
		if previewFileRe.MatchString(e.Name) && now.Sub(e.Mtime) > drawingCacheMinAge {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) == 0 {
		return 0, nil
	}
	current, err := currentDrawingHashes(ctx, db)
	if err != nil {
		return 0, err // without the set of live hashes nothing can be told orphan
	}
	removed := 0
	var first error
	for _, e := range candidates {
		if ctx.Err() != nil {
			return removed, ctx.Err()
		}
		if current[previewFileRe.FindStringSubmatch(e.Name)[1]] {
			continue
		}
		if err := fsys.Delete(e.Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			if first == nil {
				first = err
			}
			continue
		}
		removed++
	}
	return removed, first
}

// currentDrawingHashes is the set of content hashes the indexed drawings have now.
func currentDrawingHashes(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT hash FROM files WHERE kind = 'excalidraw'`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		out[h] = true
	}
	return out, rows.Err()
}

// pruneDrawingCacheLogged runs pruneDrawingCache and reports the outcome in the log only.
func pruneDrawingCacheLogged(ctx context.Context, log zerolog.Logger, fsys *vault.FS, db *sql.DB) {
	n, err := pruneDrawingCache(ctx, fsys, db, time.Now())
	if err != nil && ctx.Err() == nil {
		log.Warn().Err(err).Int("removed", n).Msg("drawing preview cache not fully pruned")
		return
	}
	if n > 0 {
		log.Debug().Int("removed", n).Msg("drawing preview cache pruned")
	}
}
