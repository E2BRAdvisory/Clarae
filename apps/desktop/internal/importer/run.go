package importer

import (
	"context"
	"errors"
	"fmt"
	"time"

	"memobrain/shared/pathrules"
)

// source adapts an exec function to the Importer interface, so Preview and Run share it.
type source struct {
	id     string
	detect func(path string) (bool, error)
	exec   func(r *run, path string) error
}

func (s *source) ID() string                    { return s.id }
func (s *source) Detect(p string) (bool, error) { return s.detect(p) }
func (s *source) Run(ctx context.Context, p string, opts Options, progress ProgressFunc) (Report, error) {
	if opts.sink == nil {
		return Report{}, errors.New("internal: no sink bound to the import")
	}
	return s.execute(ctx, p, opts, progress, true)
}

func (s *source) Preview(ctx context.Context, p string, opts Options) (Preview, error) {
	opts.sink = NewDryRunSink(nil)
	if opts.TargetFolder == "" {
		opts.TargetFolder = DefaultFolder(s.id, opts.clock())
	}
	rep, err := s.execute(ctx, p, opts, nil, false)
	if err != nil {
		return Preview{}, err
	}
	pv := Preview{
		Notes: rep.NotesCreated, Attachments: rep.AttachmentsCreated, Warnings: rep.Warnings,
		TargetFolder: rep.Folder, Titles: []string{}, Columns: []string{},
	}
	if pv.Warnings == nil {
		pv.Warnings = []string{}
	}
	for _, it := range rep.Created {
		if it.Kind == "note" && len(pv.Titles) < 12 {
			pv.Titles = append(pv.Titles, it.Title)
		}
	}
	for _, it := range rep.Failed {
		pv.Warnings = append(pv.Warnings, it.Source+": "+it.Reason)
	}
	pv.Columns, pv.Delimiter = rep.csvColumns, rep.csvDelimiter
	if pv.Columns == nil {
		pv.Columns = []string{}
	}
	return pv, nil
}

func (s *source) execute(ctx context.Context, p string, opts Options, progress ProgressFunc, writeReport bool) (Report, error) {
	r := &run{ctx: ctx, opts: opts, sink: opts.sink, progress: progress, id: s.id, lim: opts.lim()}
	r.started = opts.clock()
	folder := opts.TargetFolder
	if folder == "" {
		folder = DefaultFolder(s.id, r.started)
	}
	norm, err := pathrules.Normalize(folder)
	if err != nil {
		return Report{}, fmt.Errorf("invalid: target folder: %w", err)
	}
	r.target = norm
	r.rep.SourceID, r.rep.Folder = s.id, norm
	err = s.exec(r, p)
	if err != nil && !errors.Is(err, context.Canceled) {
		return Report{}, err
	}
	if ctx.Err() != nil {
		r.rep.Cancelled = true
	}
	r.rep.FinishedAt = opts.clock().UTC().Format(time.RFC3339)
	r.rep.StartedAt = r.started.UTC().Format(time.RFC3339)
	r.finishLinks()
	if writeReport && r.sink != nil && !r.sink.Dry() {
		r.writeReportNote()
	}
	return r.rep, nil
}

// run is the state of one import.
type run struct {
	ctx      context.Context
	id       string
	opts     Options
	lim      Limits
	sink     Sink
	progress ProgressFunc
	target   string
	started  time.Time
	rep      Report
	done     int
	total    int

	moreWarnings int
}

func (r *run) setTotal(n int) { r.total = n }

// step records progress and reports cancellation.
func (r *run) step(current string) error {
	if err := r.ctx.Err(); err != nil {
		return err
	}
	r.done++
	if r.progress != nil {
		r.progress(r.done, max(r.total, r.done), current)
	}
	return nil
}

func (r *run) warn(format string, args ...any) {
	if len(r.rep.Warnings) >= maxWarnings {
		r.moreWarnings++
		return
	}
	r.rep.Warnings = append(r.rep.Warnings, fmt.Sprintf(format, args...))
}

func (r *run) finishLinks() {
	if r.moreWarnings > 0 {
		r.rep.Warnings = append(r.rep.Warnings, fmt.Sprintf("... and %d more warnings", r.moreWarnings))
		r.moreWarnings = 0
	}
}

// reserve picks the final path of a file below the target folder.
func (r *run) reserve(rel string) (string, error) { return r.sink.Reserve(joinPath(r.target, rel)) }

// reserveAbs reserves a vault path outside the target folder (attachments folder).
func (r *run) reserveAbs(rel string) (string, error) { return r.sink.Reserve(rel) }

// attachmentsDir is where generated attachments go.
func (r *run) attachmentsDir() string {
	if r.opts.AttachmentsFolder != "" {
		return r.opts.AttachmentsFolder
	}
	return joinPath(r.target, "attachments")
}

func (r *run) created(kind, src, dest, title string) {
	if kind == "note" {
		r.rep.NotesCreated++
	} else {
		r.rep.AttachmentsCreated++
	}
	if len(r.rep.Created) < maxCreatedItems {
		r.rep.Created = append(r.rep.Created, Item{Kind: kind, Source: src, Dest: dest, Title: title})
	} else {
		r.rep.CreatedTruncated = true
	}
}

func (r *run) skip(kind, src, reason string) {
	if len(r.rep.Skipped) < maxIssueItems {
		r.rep.Skipped = append(r.rep.Skipped, Item{Kind: kind, Source: src, Reason: reason})
	}
}

func (r *run) fail(kind, src, dest string, err error) {
	if len(r.rep.Failed) < maxIssueItems {
		r.rep.Failed = append(r.rep.Failed, Item{Kind: kind, Source: src, Dest: dest, Reason: err.Error()})
	}
}

// putNote reserves and writes a note below the target folder (dir relative to it).
func (r *run) putNote(src, title, dir, name string, data []byte) error {
	dest, err := r.reserve(joinPath(dir, name+".md"))
	if err != nil {
		r.fail("note", src, "", err)
		return err
	}
	return r.writeNote(src, title, dest, data)
}

// writeNote writes data at an already reserved path.
func (r *run) writeNote(src, title, dest string, data []byte) error {
	if err := r.sink.Write(dest, data); err != nil {
		r.fail("note", src, dest, err)
		return err
	}
	r.created("note", src, dest, title)
	return nil
}

func (r *run) writeAttachment(src, dest string, data []byte) error {
	if err := r.sink.Write(dest, data); err != nil {
		r.fail("attachment", src, dest, err)
		return err
	}
	r.created("attachment", src, dest, "")
	return nil
}

// putAttachment stores generated attachment data in the attachments folder.
func (r *run) putAttachment(src, name string, data []byte) (string, error) {
	dest, err := r.reserveAbs(joinPath(r.attachmentsDir(), sanitizeFile(name)))
	if err != nil {
		r.fail("attachment", src, "", err)
		return "", err
	}
	return dest, r.writeAttachment(src, dest, data)
}
