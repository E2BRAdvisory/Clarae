package main

import (
	"os"
	"path/filepath"
	"time"

	"github.com/rs/zerolog"
)

// spoolPatterns are the temporary files of blob uploads and export archives.
var spoolPatterns = []string{"memobrain-blob-*", "memobrain-upload-*", "memobrain-export-*"}

// staleSpoolAge is how old (last write) a spool file must be to be swept: a
// file in use is written continuously, and even the upload of a large archive
// to the object store ends long before.
const staleSpoolAge = 6 * time.Hour

// sweepSpool removes the spool files a crashed process left in dir. The temp
// dir survives container restarts (an emptyDir lives as long as the pod; the
// compose worker keeps it on a volume), so leftovers would add up against its
// size limit. Files still being written are recent and are kept, so a temp
// dir shared with another running process is safe.
func sweepSpool(dir string, now time.Time, log zerolog.Logger) {
	removed := 0
	for _, pattern := range spoolPatterns {
		matches, err := filepath.Glob(filepath.Join(dir, pattern))
		if err != nil {
			continue
		}
		for _, m := range matches {
			st, err := os.Lstat(m)
			if err != nil || !st.Mode().IsRegular() || now.Sub(st.ModTime()) < staleSpoolAge {
				continue
			}
			if err := os.Remove(m); err == nil {
				removed++
			}
		}
	}
	if removed > 0 {
		log.Info().Int("files", removed).Str("dir", dir).Msg("removed stale spool files")
	}
}
