package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"memobrain/apps/desktop/internal/bases"
	"memobrain/apps/desktop/internal/vault"
)

// BasesAPI exposes ".base" files (§2.2.1 "Bases"): load, run a view over the
// indexed properties, edit properties of rows and save view changes.
type BasesAPI struct{ app *App }

// NewBasesAPI binds the API.
func NewBasesAPI(a *App) *BasesAPI { return &BasesAPI{app: a} }

// ViewInfo describes a view for the UI.
type ViewInfo struct {
	Name        string           `json:"name"`
	Type        string           `json:"type"`
	Supported   bool             `json:"supported"`
	Notice      string           `json:"notice"`
	Order       []string         `json:"order"`
	Sort        []bases.SortSpec `json:"sort"`
	GroupBy     *bases.SortSpec  `json:"groupBy"`
	Limit       int              `json:"limit"`
	Filters     []bases.Chip     `json:"filters"`
	BaseFilters []bases.Chip     `json:"baseFilters"`
}

// FormulaInfo is a named formula of a base.
type FormulaInfo struct {
	Name  string `json:"name"`
	Expr  string `json:"expr"`
	Error string `json:"error"`
}

// BaseInfo is a parsed .base file.
type BaseInfo struct {
	Path       string        `json:"path"`
	Hash       string        `json:"hash"`
	ParseError string        `json:"parseError"` // the file is not usable: the UI offers the raw YAML
	Views      []ViewInfo    `json:"views"`
	Formulas   []FormulaInfo `json:"formulas"`
	Notices    []string      `json:"notices"`
}

func (b *BasesAPI) readBase(vaultID, basePath string) (*openVault, vault.Content, error) {
	if !strings.HasSuffix(strings.ToLower(basePath), ".base") {
		return nil, vault.Content{}, fmt.Errorf("invalid: %q is not a .base file", basePath)
	}
	ov, err := b.app.vault(vaultID)
	if err != nil {
		return nil, vault.Content{}, err
	}
	c, err := ov.FS.ReadFile(basePath)
	if err != nil {
		return nil, vault.Content{}, bindingError(err)
	}
	if len(c.Data) > maxBaseSize {
		return nil, vault.Content{}, fmt.Errorf("invalid: %q is too large for a base (more than %d bytes)", c.Path, maxBaseSize)
	}
	return ov, c, nil
}

// A .base file may come from a shared vault: its size is bounded before the
// YAML is parsed, and a run gets a deadline besides the engine's own budget.
const (
	maxBaseSize    = 1 << 20
	baseRunTimeout = 10 * time.Second
)

// Load parses a base. Unsupported constructs never fail the call: they are
// reported in Notices and per view.
func (b *BasesAPI) Load(vaultID, basePath string) (BaseInfo, error) {
	_, c, err := b.readBase(vaultID, basePath)
	if err != nil {
		return BaseInfo{}, err
	}
	info := BaseInfo{Path: c.Path, Hash: c.Hash, Views: []ViewInfo{}, Formulas: []FormulaInfo{}, Notices: []string{}}
	base, err := bases.Parse(c.Data)
	if err != nil {
		info.ParseError = err.Error()
		return info, nil
	}
	info.Notices = append(info.Notices, base.Notices...)
	for _, name := range base.FormulaOrder {
		f := base.Formulas[name]
		info.Formulas = append(info.Formulas, FormulaInfo{Name: name, Expr: f.Src, Error: f.Err})
	}
	baseChips := base.Filters.Chips()
	for i := range baseChips {
		baseChips[i].Simple, baseChips[i].Index = false, -1
	}
	for _, v := range base.Views {
		vi := ViewInfo{
			Name: v.Name, Type: v.Type, Supported: v.Supported, Notice: v.Notice,
			Order: v.Order, Sort: v.Sort, GroupBy: v.GroupBy, Limit: v.Limit,
			Filters: v.Filters.Chips(), BaseFilters: baseChips,
		}
		if vi.Order == nil {
			vi.Order = []string{}
		}
		if vi.Sort == nil {
			vi.Sort = []bases.SortSpec{}
		}
		if vi.Filters == nil {
			vi.Filters = []bases.Chip{}
		}
		if vi.BaseFilters == nil {
			vi.BaseFilters = []bases.Chip{}
		}
		info.Views = append(info.Views, vi)
	}
	return info, nil
}

// Run evaluates a view of a base over the indexed notes. thisPath is the note
// that contains the base (the base itself when it is opened directly).
func (b *BasesAPI) Run(vaultID, basePath string, viewIndex int, thisPath string) (bases.Result, error) {
	ov, c, err := b.readBase(vaultID, basePath)
	if err != nil {
		return bases.Result{}, err
	}
	base, err := bases.Parse(c.Data)
	if err != nil {
		return bases.Result{}, fmt.Errorf("invalid: %w", err)
	}
	notes, err := bases.LoadNotes(context.Background(), ov.Indexer.DB())
	if err != nil {
		return bases.Result{}, err
	}
	opts := bases.RunOptions{Now: time.Now(), Schema: map[string]string{}}
	for k, v := range NewPropertiesAPI(b.app).schema(ov) {
		opts.Schema[k] = string(v)
	}
	if thisPath == "" {
		thisPath = c.Path
	}
	for _, n := range notes {
		if n.Path == thisPath {
			opts.This = n
			break
		}
	}
	opts.OnPanic = logBasePanic
	ctx, cancel := context.WithTimeout(context.Background(), baseRunTimeout)
	defer cancel()
	res, err := base.RunContext(ctx, notes, viewIndex, opts)
	var pe *bases.PanicError
	switch {
	case err == nil:
		return *res, nil
	case errors.As(err, &pe):
		return bases.Result{}, coded(ErrCodeInternal, "the base could not be evaluated; see the log", err)
	case errors.Is(err, context.DeadlineExceeded):
		return bases.Result{}, coded(ErrCodeCancelled, "the base took too long to evaluate", err)
	case errors.Is(err, context.Canceled):
		return bases.Result{}, bindingError(err)
	}
	return bases.Result{}, fmt.Errorf("invalid: %w", err)
}

// logBasePanic logs an unexpected failure of the Bases engine with its stack:
// the binding only answers with a generic message.
func logBasePanic(err error) {
	l := bindingLog.Load()
	if l == nil {
		return
	}
	ev := l.Error().Err(err)
	var pe *bases.PanicError
	if errors.As(err, &pe) {
		ev = ev.Bytes("stack", pe.Stack)
	}
	ev.Msg("bases: evaluation failed unexpectedly")
}

// UpdateView applies a JSON-encoded bases.ViewPatch to the .base file,
// preserving everything the patch does not touch (unknown keys, comments).
func (b *BasesAPI) UpdateView(vaultID, basePath string, viewIndex int, patchJSON, expectedHash string) (WriteResult, error) {
	if err := b.app.writable(vaultID); err != nil {
		return WriteResult{}, err
	}
	ov, cur, err := b.readBase(vaultID, basePath)
	if err != nil {
		return WriteResult{}, err
	}
	if expectedHash != "" && cur.Hash != expectedHash {
		return WriteResult{}, bindingError(vault.ErrHashMismatch)
	}
	var patch bases.ViewPatch
	if err := json.Unmarshal([]byte(patchJSON), &patch); err != nil {
		return WriteResult{}, fmt.Errorf("invalid: patch is not JSON: %w", err)
	}
	out, err := bases.ApplyViewPatch(cur.Data, viewIndex, patch)
	if err != nil {
		return WriteResult{}, fmt.Errorf("invalid: %w", err)
	}
	c, err := ov.FS.WriteFile(cur.Path, out, cur.Hash, false)
	if err != nil {
		return WriteResult{}, bindingError(err)
	}
	_ = ov.Indexer.Update(context.Background(), []string{c.Path})
	return WriteResult{Path: c.Path, Hash: c.Hash, Size: c.Size}, nil
}

// UpdateProperty edits a frontmatter property of a row through the same
// hash-guarded path as the Properties panel.
func (b *BasesAPI) UpdateProperty(vaultID, notePath, key, valueJSON, expectedHash string) (WriteResult, error) {
	if key == "" || strings.HasPrefix(key, "file.") || strings.HasPrefix(key, "formula.") {
		return WriteResult{}, errors.New("invalid: only note properties can be edited")
	}
	if !strings.HasSuffix(strings.ToLower(notePath), ".md") {
		return WriteResult{}, errors.New("invalid: only Markdown notes have properties")
	}
	return NewPropertiesAPI(b.app).Update(vaultID, notePath, strings.TrimPrefix(key, "note."), valueJSON, expectedHash)
}

// NewBaseContent returns the text of a new minimal base listing the notes of folder.
func (b *BasesAPI) NewBaseContent(folder string) string {
	return string(bases.NewBase(folder))
}
