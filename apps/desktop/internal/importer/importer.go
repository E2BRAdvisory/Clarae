// Package importer brings notes from other applications into a vault (M6-WP4).
//
// Every source implements Importer. Sources are UNTRUSTED files: all parsing is bounded
// (entry counts, uncompressed sizes, XML/JSON/CSV sizes), archive entry names are validated
// before use and never used as destination paths, HTML is converted to Markdown (never kept
// as markup), and every destination goes through a Sink that resolves paths with the vault
// path rules and never overwrites an existing file.
//
// Preview and Run share one code path: Preview runs the importer against a dry-run sink, so
// the counts and warnings shown before the import are exactly what the import will produce.
package importer

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// Importer is one import source.
type Importer interface {
	// ID is the stable identifier of the source ("enex", "notion", ...).
	ID() string
	// Detect reports whether path looks like an export of this source (cheap, no full parse).
	Detect(path string) (bool, error)
	// Preview parses the source without writing anything.
	Preview(ctx context.Context, path string, opts Options) (Preview, error)
	// Run imports the source into the vault through opts' sink.
	Run(ctx context.Context, path string, opts Options, progress ProgressFunc) (Report, error)
}

// ProgressFunc is called as the import advances. total may grow while a source is scanned.
type ProgressFunc func(done, total int, current string)

// CSVOptions maps the columns of a CSV source.
type CSVOptions struct {
	// Delimiter is one character, or "" to detect it.
	Delimiter string `json:"delimiter"`
	// NoHeader tells that the first row is data, not column names ("Column N" names are used).
	NoHeader bool `json:"noHeader"`
	// TitleColumn and BodyColumn are column names; the title
	// defaults to the first column, an empty body column means "no body".
	TitleColumn string `json:"titleColumn"`
	BodyColumn  string `json:"bodyColumn"`
}

// Options configure one import.
type Options struct {
	// TargetFolder is the vault folder that receives the notes (default Imports/<source>-<date>).
	TargetFolder string `json:"targetFolder"`
	// UseWikilinks rewrites relative Markdown links to [[wikilinks]] and embeds; otherwise
	// Markdown links are kept and only their paths are fixed.
	UseWikilinks bool `json:"useWikilinks"`
	// AttachmentsFolder receives attachments; empty means "next to the notes" (folder
	// sources keep their structure) or <TargetFolder>/attachments (generated attachments).
	AttachmentsFolder string `json:"attachmentsFolder"`
	// IncludeArchived and IncludeTrashed select Google Keep notes.
	IncludeArchived bool `json:"includeArchived"`
	IncludeTrashed  bool `json:"includeTrashed"`
	// CSV applies to the CSV source.
	CSV CSVOptions `json:"csv"`

	sink   Sink
	limits Limits
	now    func() time.Time
}

// WithSink returns opts bound to the sink that receives the files.
func (o Options) WithSink(s Sink) Options { o.sink = s; return o }

func (o Options) clock() time.Time {
	if o.now != nil {
		return o.now()
	}
	return time.Now()
}

func (o Options) lim() Limits {
	if o.limits == (Limits{}) {
		return DefaultLimits
	}
	return o.limits
}

// Preview is what an import would do, without writing anything.
type Preview struct {
	Notes        int      `json:"notes"`
	Attachments  int      `json:"attachments"`
	Titles       []string `json:"titles"`
	Warnings     []string `json:"warnings"`
	TargetFolder string   `json:"targetFolder"`
	// Columns and Delimiter describe a CSV source so the user can map its columns.
	Columns   []string `json:"columns"`
	Delimiter string   `json:"delimiter"`
}

// Item is one file the import created, skipped or failed on.
type Item struct {
	Kind   string `json:"kind"` // note | attachment
	Source string `json:"source"`
	Dest   string `json:"dest"`
	Title  string `json:"title"`
	Reason string `json:"reason"`
}

// Report is the outcome of an import.
type Report struct {
	SourceID           string   `json:"sourceId"`
	Folder             string   `json:"folder"`
	ReportPath         string   `json:"reportPath"`
	StartedAt          string   `json:"startedAt"`
	FinishedAt         string   `json:"finishedAt"`
	Cancelled          bool     `json:"cancelled"`
	NotesCreated       int      `json:"notesCreated"`
	AttachmentsCreated int      `json:"attachmentsCreated"`
	Created            []Item   `json:"created"`
	CreatedTruncated   bool     `json:"createdTruncated"`
	Skipped            []Item   `json:"skipped"`
	Failed             []Item   `json:"failed"`
	LinksRewritten     int      `json:"linksRewritten"`
	LinksUnresolved    int      `json:"linksUnresolved"`
	Warnings           []string `json:"warnings"`

	csvColumns   []string
	csvDelimiter string
}

// Caps on what a report keeps in memory (counts stay exact).
const (
	maxCreatedItems = 5000
	maxIssueItems   = 2000
	maxWarnings     = 200
)

// SourceInfo describes a source for the UI.
type SourceInfo struct {
	ID string `json:"id"`
	// Input is "file", "folder" or "either".
	Input      string   `json:"input"`
	Extensions []string `json:"extensions"`
}

type registration struct {
	imp  Importer
	info SourceInfo
}

var registry []registration

// Register adds a source; called from init functions of this package.
func Register(imp Importer, info SourceInfo) {
	info.ID = imp.ID()
	registry = append(registry, registration{imp, info})
}

// Sources lists the registered sources in a stable order.
func Sources() []SourceInfo {
	out := make([]SourceInfo, 0, len(registry))
	for _, r := range registry {
		out = append(out, r.info)
	}
	return out
}

// Get returns the importer with that id.
func Get(id string) (Importer, error) {
	for _, r := range registry {
		if r.imp.ID() == id {
			return r.imp, nil
		}
	}
	return nil, fmt.Errorf("invalid: unknown import source %q", id)
}

// DetectAll returns the ids of the sources that recognise path, best match first.
func DetectAll(path string) []string {
	var ids []string
	for _, r := range registry {
		if ok, err := r.imp.Detect(path); err == nil && ok {
			ids = append(ids, r.imp.ID())
		}
	}
	sort.SliceStable(ids, func(i, j int) bool { return genericity(ids[i]) < genericity(ids[j]) })
	return ids
}

// genericity ranks sources: the plain folder importer accepts anything, so it comes last.
func genericity(id string) int {
	switch id {
	case "markdown-folder":
		return 2
	case "csv":
		return 1
	}
	return 0
}

// DefaultFolder is the default target folder for a source.
func DefaultFolder(sourceID string, now time.Time) string {
	return "Imports/" + sourceID + "-" + now.Format("2006-01-02")
}
