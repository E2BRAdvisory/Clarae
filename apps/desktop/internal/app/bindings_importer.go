package app

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"memobrain/apps/desktop/internal/importer"
)

// ImportProgressPayload accompanies EventImportProgress.
type ImportProgressPayload struct {
	JobID   string `json:"jobId"`
	VaultID string `json:"vaultId"`
	Done    int    `json:"done"`
	Total   int    `json:"total"`
	Current string `json:"current"`
}

// ImportDonePayload accompanies EventImportDone.
type ImportDonePayload struct {
	JobID   string           `json:"jobId"`
	VaultID string           `json:"vaultId"`
	OK      bool             `json:"ok"`
	Error   string           `json:"error"`
	Report  *importer.Report `json:"report"`
}

type importJob struct {
	vaultID  string
	cancel   context.CancelFunc
	done     bool
	finished time.Time
	report   *importer.Report
	err      string
}

// Finished jobs are kept for Report only for a while: a report can hold thousands of items.
// The importer:done event already carries it, so Report is a fallback.
const (
	finishedImportTTL  = 15 * time.Minute
	maxFinishedImports = 4
)

// pruneLocked drops finished jobs older than finishedImportTTL and, beyond maxFinishedImports,
// the oldest ones. Running jobs are never dropped. The caller holds i.mu.
func (i *ImporterAPI) pruneLocked(now time.Time) {
	var kept []string
	for id, j := range i.jobs {
		switch {
		case !j.done:
		case now.Sub(j.finished) > finishedImportTTL:
			delete(i.jobs, id)
		default:
			kept = append(kept, id)
		}
	}
	if len(kept) <= maxFinishedImports {
		return
	}
	sort.Slice(kept, func(a, b int) bool { return i.jobs[kept[a]].finished.Before(i.jobs[kept[b]].finished) })
	for _, id := range kept[:len(kept)-maxFinishedImports] {
		delete(i.jobs, id)
	}
}

// ImporterAPI imports notes from other applications into the open vault (M6-WP4). Files are
// written through the vault file layer; the file watcher then indexes them as it does for any
// external change.
type ImporterAPI struct {
	app  *App
	mu   sync.Mutex
	jobs map[string]*importJob
}

// NewImporterAPI binds the API.
func NewImporterAPI(a *App) *ImporterAPI { return &ImporterAPI{app: a, jobs: map[string]*importJob{}} }

// ListSources lists the available import sources.
func (i *ImporterAPI) ListSources() []importer.SourceInfo { return importer.Sources() }

// Detect returns the ids of the sources that recognise path, best match first.
func (i *ImporterAPI) Detect(path string) []string {
	ids := importer.DetectAll(path)
	if ids == nil {
		ids = []string{}
	}
	return ids
}

// DefaultFolder is the proposed target folder for a source (Imports/<source>-<date>).
func (i *ImporterAPI) DefaultFolder(sourceID string) string {
	return importer.DefaultFolder(sourceID, time.Now())
}

// PickFile shows the native file picker and returns the chosen path ("" when cancelled).
// extensions are lower-case without the dot; empty means any file.
func (i *ImporterAPI) PickFile(title string, extensions []string) (string, error) {
	var filters []FileFilter
	if len(extensions) > 0 {
		pats := make([]string, 0, len(extensions))
		for _, e := range extensions {
			if e = strings.Trim(e, ". *"); e != "" {
				pats = append(pats, "*."+e)
			}
		}
		if len(pats) > 0 {
			filters = append(filters, FileFilter{DisplayName: strings.Join(pats, ", "), Pattern: strings.Join(pats, ";")})
		}
	}
	return i.app.host.OpenFile(i.app.ctx, OpenDialog{Title: title, Filters: filters})
}

func (i *ImporterAPI) baseCtx() context.Context {
	if i.app.ctx != nil {
		return i.app.ctx
	}
	return context.Background()
}

// Preview parses the source and reports what an import would create; nothing is written.
func (i *ImporterAPI) Preview(vaultID, sourceID, path string, opts importer.Options) (importer.Preview, error) {
	if _, err := i.app.vault(vaultID); err != nil {
		return importer.Preview{}, err
	}
	imp, err := importer.Get(sourceID)
	if err != nil {
		return importer.Preview{}, err
	}
	ctx, cancel := context.WithTimeout(i.baseCtx(), 5*time.Minute)
	defer cancel()
	return imp.Preview(ctx, path, opts)
}

// Run starts an import in the background and returns its job id. Progress and completion
// arrive as events; Report returns the final report.
func (i *ImporterAPI) Run(vaultID, sourceID, path string, opts importer.Options) (string, error) {
	if err := i.app.writable(vaultID); err != nil {
		return "", err
	}
	ov, err := i.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	imp, err := importer.Get(sourceID)
	if err != nil {
		return "", err
	}
	i.mu.Lock()
	i.pruneLocked(time.Now())
	for _, j := range i.jobs {
		if j.vaultID == vaultID && !j.done {
			i.mu.Unlock()
			return "", errors.New("busy: another import is running in this vault")
		}
	}
	id := uuid.NewString()
	ctx, cancel := context.WithCancel(i.baseCtx())
	job := &importJob{vaultID: vaultID, cancel: cancel}
	i.jobs[id] = job
	i.mu.Unlock()

	opts = opts.WithSink(importer.NewVaultSink(ov.FS))
	go func() {
		defer cancel()
		var last time.Time
		progress := func(done, total int, current string) {
			if now := time.Now(); now.Sub(last) >= 100*time.Millisecond || done >= total {
				last = now
				EventImportProgress.Send(i.app.emit, ImportProgressPayload{JobID: id, VaultID: vaultID, Done: done, Total: total, Current: current})
			}
		}
		rep, err := imp.Run(ctx, path, opts, progress)
		i.mu.Lock()
		job.done, job.finished = true, time.Now()
		payload := ImportDonePayload{JobID: id, VaultID: vaultID, OK: err == nil}
		if err != nil {
			job.err = err.Error()
			payload.Error = job.err
			i.app.logger.Warn().Err(err).Str("source", sourceID).Msg("import failed")
		} else {
			job.report = &rep
			payload.Report = &rep
			i.app.logger.Info().Str("source", sourceID).Int("notes", rep.NotesCreated).Int("attachments", rep.AttachmentsCreated).Msg("import finished")
		}
		i.pruneLocked(job.finished)
		i.mu.Unlock()
		EventImportDone.Send(i.app.emit, payload)
	}()
	return id, nil
}

// Cancel stops a running import; what was already written stays (it is listed in the report).
func (i *ImporterAPI) Cancel(jobID string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	j, ok := i.jobs[jobID]
	if !ok {
		return fmt.Errorf("not-found: unknown import %q", jobID)
	}
	j.cancel()
	return nil
}

// Report returns the report of a finished import. A finished job is forgotten once its report
// was read (and anyway after a while, see pruneLocked), so a second call is not-found.
func (i *ImporterAPI) Report(jobID string) (importer.Report, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.pruneLocked(time.Now())
	j, ok := i.jobs[jobID]
	if !ok {
		return importer.Report{}, fmt.Errorf("not-found: unknown import %q", jobID)
	}
	if !j.done {
		return importer.Report{}, errors.New("busy: the import is still running")
	}
	delete(i.jobs, jobID)
	if j.report == nil {
		return importer.Report{}, errors.New(j.err)
	}
	return *j.report, nil
}
