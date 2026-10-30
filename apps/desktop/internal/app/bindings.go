package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Bios-Marcel/wastebasket/v2"

	"memobrain/apps/desktop/internal/links"
	"memobrain/apps/desktop/internal/search"
	"memobrain/apps/desktop/internal/vault"
)

// The API structs below are bound to the frontend by Wails (see main.go);
// every exported method becomes a typed TypeScript function in
// frontend/wailsjs. Methods validate input and return plain data: the
// frontend never touches disk or network directly (§1.2).

// VaultAPI exposes vault and file operations.
type VaultAPI struct{ app *App }

// NewVaultAPI binds the API.
func NewVaultAPI(a *App) *VaultAPI { return &VaultAPI{app: a} }

// NoteContent is a file read with its hash (for optimistic writes).
type NoteContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Hash    string `json:"hash"`
	Size    int64  `json:"size"`
}

// WriteResult reports a completed write.
type WriteResult struct {
	Path string `json:"path"`
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

// ListRecent returns recently opened vaults, most recent first.
func (v *VaultAPI) ListRecent() ([]VaultInfo, error) { return v.app.recentVaults() }

// ListOpen returns the vaults open in this process.
func (v *VaultAPI) ListOpen() []VaultInfo {
	v.app.mu.Lock()
	defer v.app.mu.Unlock()
	out := make([]VaultInfo, 0, len(v.app.vaults))
	for _, ov := range v.app.vaults {
		out = append(out, ov.Info)
	}
	return out
}

// PickFolder shows the native folder picker and returns the chosen path ("" when cancelled).
func (v *VaultAPI) PickFolder(title string) (string, error) {
	return v.app.host.OpenDirectory(v.app.ctx, OpenDialog{Title: title, CanCreateDirectories: true})
}

// ExportResult reports an export of a vault to a ZIP file.
type ExportResult struct {
	// Path is where the archive was written; empty when the user cancelled.
	Path      string `json:"path"`
	Files     int    `json:"files"`
	Bytes     int64  `json:"bytes"`
	Cancelled bool   `json:"cancelled"`
}

// ExportZip asks where to save and writes the vault as a ZIP archive (the native "save as"
// dialog suggests <vault>-<date>.zip). Cancelling the dialog is not an error.
func (v *VaultAPI) ExportZip(vaultID string) (ExportResult, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return ExportResult{}, err
	}
	dest, err := v.app.host.SaveFile(v.app.ctx, SaveDialog{
		Title:           "Export vault as ZIP",
		DefaultFilename: exportFilename(ov.Info.Name, time.Now()),
		Filters:         []FileFilter{{DisplayName: "ZIP archive (*.zip)", Pattern: "*.zip"}},
	})
	if err != nil {
		return ExportResult{}, err
	}
	if dest == "" {
		return ExportResult{Cancelled: true}, nil
	}
	res, err := v.app.exportZip(vaultID, dest)
	if err == nil {
		v.app.host.Delivered(v.app.ctx, res.Path)
	}
	return res, err
}

// exportFilename proposes a file name for an export, keeping only characters safe on every platform.
func exportFilename(vaultName string, now time.Time) string {
	var b strings.Builder
	for _, r := range vaultName {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.', r > 127:
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('_')
		}
	}
	name := strings.Trim(b.String(), "._")
	if name == "" {
		name = "vault"
	}
	return name + "-" + now.Format("20060102") + ".zip"
}

// exportZip writes the archive next to its destination and renames it into place, so a
// failed or interrupted export never leaves a truncated file under the chosen name.
func (a *App) exportZip(vaultID, dest string) (ExportResult, error) {
	ov, err := a.vault(vaultID)
	if err != nil {
		return ExportResult{}, err
	}
	if !strings.EqualFold(filepath.Ext(dest), ".zip") {
		dest += ".zip"
	}
	// Writing the archive inside the vault would pack it into itself on the next export.
	// The vault root has its symlinks resolved, so the destination folder must too.
	if dir, err := filepath.EvalSymlinks(filepath.Dir(dest)); err == nil {
		if rel, err := filepath.Rel(ov.FS.Root(), filepath.Join(dir, filepath.Base(dest))); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return ExportResult{}, errors.New("choose a location outside the vault")
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".memobrain-export-*.part")
	if err != nil {
		return ExportResult{}, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	st, err := ov.FS.ExportZip(a.ctx, tmp)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return ExportResult{}, err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return ExportResult{}, err
	}
	return ExportResult{Path: dest, Files: st.Files, Bytes: st.Bytes}, nil
}

// OpenVault opens the folder at path as a vault (creating the folder if needed).
func (v *VaultAPI) OpenVault(path string) (VaultInfo, error) {
	if path == "" {
		return VaultInfo{}, errors.New("path is required")
	}
	return v.app.openVault(path)
}

// CloseVault closes an open vault.
func (v *VaultAPI) CloseVault(vaultID string) error {
	v.app.mu.Lock()
	defer v.app.mu.Unlock()
	ov, ok := v.app.vaults[vaultID]
	if !ok {
		return ErrVaultNotOpen
	}
	v.app.closeVaultLocked(vaultID, ov)
	return nil
}

// ListTree returns every file and folder of the vault (flat, sorted).
func (v *VaultAPI) ListTree(vaultID string) ([]vault.Entry, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	entries, err := ov.FS.ListTree()
	if entries == nil {
		entries = []vault.Entry{}
	}
	return entries, err
}

// ReadNote reads a text file.
func (v *VaultAPI) ReadNote(vaultID, relPath string) (NoteContent, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return NoteContent{}, err
	}
	c, err := ov.FS.ReadFile(relPath)
	if err != nil {
		return NoteContent{}, err
	}
	return NoteContent{Path: c.Path, Content: string(c.Data), Hash: c.Hash, Size: c.Size}, nil
}

// WriteNote writes a text file atomically. expectedHash must be the hash
// returned by the last ReadNote/WriteNote of that file; an empty hash means
// "create" (fails if the file exists).
func (v *VaultAPI) WriteNote(vaultID, relPath, content, expectedHash string) (WriteResult, error) {
	if err := v.app.writable(vaultID); err != nil {
		return WriteResult{}, err
	}
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return WriteResult{}, err
	}
	c, err := ov.FS.WriteFile(relPath, []byte(content), expectedHash, expectedHash == "")
	if err != nil {
		return WriteResult{}, bindingError(err)
	}
	_ = ov.Indexer.Update(context.Background(), []string{c.Path})
	return WriteResult{Path: c.Path, Hash: c.Hash, Size: c.Size}, nil
}

// CreateFolder creates a folder (and parents).
func (v *VaultAPI) CreateFolder(vaultID, relPath string) error {
	if err := v.app.writable(vaultID); err != nil {
		return err
	}
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return err
	}
	return bindingError(ov.FS.Mkdir(relPath))
}

// Rename moves a file or folder. Link rewriting (RenameWithLinkUpdate) arrives in M1-WP3.
func (v *VaultAPI) Rename(vaultID, fromPath, toPath string) error {
	if err := v.app.writable(vaultID); err != nil {
		return err
	}
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return err
	}
	if err := ov.FS.Rename(fromPath, toPath); err != nil {
		return bindingError(err)
	}
	v.app.sync.Renamed(context.Background(), vaultID, fromPath, toPath)
	return ov.Indexer.Update(context.Background(), []string{fromPath, toPath})
}

// Trash deletes a file or folder recoverably: to the OS trash or to the
// vault's .trash/ folder, depending on the TrashMode setting. It returns the
// new vault-relative path for the vault trash and "" for the OS trash.
func (v *VaultAPI) Trash(vaultID, relPath string) (string, error) {
	if err := v.app.writable(vaultID); err != nil {
		return "", err
	}
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	mode := "system"
	if cur, err := NewSettingsAPI(v.app).Get(); err == nil && cur.TrashMode != "" {
		mode = cur.TrashMode
	}
	var dest string
	if mode == "system" && isWeb {
		mode = "vault" // a browser has no OS trash
	}
	if mode == "system" {
		abs, _, err := ov.FS.Resolve(relPath)
		if err != nil {
			return "", bindingError(err)
		}
		if err := wastebasket.Trash(abs); err != nil {
			// No usable OS trash (e.g. a headless Linux): fall back to the vault trash.
			v.app.logger.Warn().Err(err).Msg("system trash unavailable; using .trash")
			mode = "vault"
		}
	}
	if mode == "vault" {
		if dest, err = ov.FS.Trash(relPath); err != nil {
			return "", bindingError(err)
		}
	}
	_ = ov.Indexer.Update(context.Background(), []string{relPath})
	return dest, nil
}

// RebuildIndex drops and rebuilds the vault index.
func (v *VaultAPI) RebuildIndex(vaultID string) error {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return err
	}
	return ov.Indexer.Rebuild(context.Background())
}

// SearchAPI exposes full-text search.
type SearchAPI struct{ app *App }

// NewSearchAPI binds the API.
func NewSearchAPI(a *App) *SearchAPI { return &SearchAPI{app: a} }

// Query runs a search in the vault query language (§2.4): terms, phrases,
// OR, -, parentheses, file:/path:/content:/tag:/line:/block:/section:/task:
// operators, [property:value] filters and /regex/. sortBy is "relevance",
// "name" or "modified". A malformed query returns an error whose message
// starts with "query:".
func (s *SearchAPI) Query(vaultID, q, sortBy string, limit int) (search.Results, error) {
	ov, err := s.app.vault(vaultID)
	if err != nil {
		return search.Results{}, err
	}
	return search.New(ov.Indexer.DB()).Query(context.Background(), q, search.Options{Limit: limit, Sort: sortBy})
}

// Explain describes how a query is interpreted ("explain search terms").
func (s *SearchAPI) Explain(q string) ([]string, error) { return search.Explain(q) }

// SettingsAPI exposes application preferences (not vault settings).
type SettingsAPI struct{ app *App }

// NewSettingsAPI binds the API.
func NewSettingsAPI(a *App) *SettingsAPI { return &SettingsAPI{app: a} }

// AppSettings are the application-level preferences.
type AppSettings struct {
	Language string `json:"language"` // "it" | "en" | "" (system)
	Theme    string `json:"theme"`    // "system" | "light" | "dark"
	// TrashMode is where deleted files go: "system" (OS trash, default) or
	// "vault" (the vault's .trash/ folder).
	TrashMode string `json:"trashMode"`
	// VaultLockMinutes locks an unlocked private vault after this much idle
	// time (0 = never); nil follows the administrator's default (§3.8.2).
	VaultLockMinutes *int `json:"vaultLockMinutes,omitempty"`
}

// Get returns the saved preferences (defaults when unset).
func (s *SettingsAPI) Get() (AppSettings, error) {
	out := AppSettings{Theme: "system", TrashMode: "system"}
	if s.app.appDB == nil {
		return out, nil
	}
	var raw string
	err := s.app.appDB.QueryRowContext(s.app.ctx, `SELECT value FROM app_settings WHERE key = 'app'`).Scan(&raw)
	if err != nil {
		return out, nil //nolint:nilerr // missing row means defaults
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out, nil
}

// Set persists the preferences.
func (s *SettingsAPI) Set(settings AppSettings) error {
	switch settings.Theme {
	case "", "system", "light", "dark":
	default:
		return fmt.Errorf("invalid theme %q", settings.Theme)
	}
	switch settings.TrashMode {
	case "", "system", "vault":
	default:
		return fmt.Errorf("invalid trash mode %q", settings.TrashMode)
	}
	if m := settings.VaultLockMinutes; m != nil && (*m < 0 || *m > maxVaultLockMinutes) {
		return fmt.Errorf("vault lock must be between 0 and %d minutes", maxVaultLockMinutes)
	}
	raw, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	if _, err = s.app.appDB.ExecContext(s.app.ctx, `INSERT INTO app_settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, string(raw)); err != nil {
		return err
	}
	s.app.applyLockTimeout()
	return nil
}

// Info returns build and environment facts for the About panel.
func (s *SettingsAPI) Info() map[string]string {
	platform := "desktop" // "web" when the core runs in the browser: the UI hides what only a desktop can do (ADR-0029)
	if isWeb {
		platform = "web"
	}
	return map[string]string{
		"platform": platform,
		"version":  s.app.opts.Version,
		"dataDir":  s.app.opts.DataDir,
		// Convenience for development: MEMOBRAIN_DEFAULT_SERVER_URL prefills the sign-in form.
		"defaultServer": os.Getenv("MEMOBRAIN_DEFAULT_SERVER_URL"),
	}
}

// bindingError maps file-system errors to stable messages the frontend can
// branch on (the message is the contract until typed errors exist in Wails v2).
func bindingError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, vault.ErrHashMismatch):
		return errors.New("conflict: file changed on disk")
	case errors.Is(err, vault.ErrExists):
		return errors.New("exists: destination already exists")
	case errors.Is(err, vault.ErrNotFound):
		return errors.New("not-found: no such file")
	case errors.Is(err, vault.ErrOutsideVault):
		return errors.New("invalid-path: outside the vault")
	default:
		return err
	}
}

// LinksAPI exposes link resolution queries (§2.5 "links").
type LinksAPI struct{ app *App }

// NewLinksAPI binds the API.
func NewLinksAPI(a *App) *LinksAPI { return &LinksAPI{app: a} }

// Outgoing lists the links written in a note (unresolved ones are ghosts).
func (l *LinksAPI) Outgoing(vaultID, relPath string) ([]links.Link, error) {
	ov, err := l.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	return links.Outgoing(context.Background(), ov.Indexer.DB(), relPath)
}

// Backlinks lists the links in other notes that point at a note.
func (l *LinksAPI) Backlinks(vaultID, relPath string) ([]links.Link, error) {
	ov, err := l.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	return links.Backlinks(context.Background(), ov.Indexer.DB(), relPath)
}

// UnlinkedMentions lists notes that mention this note's title without linking.
func (l *LinksAPI) UnlinkedMentions(vaultID, relPath string) ([]links.Mention, error) {
	ov, err := l.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	return links.UnlinkedMentions(context.Background(), ov.Indexer.DB(), relPath)
}

// PlanRename previews renaming or moving a file or folder: which files move
// and which notes would have links rewritten. Nothing is changed.
func (l *LinksAPI) PlanRename(vaultID, from, to string) (links.Plan, error) {
	ov, err := l.app.vault(vaultID)
	if err != nil {
		return links.Plan{}, err
	}
	plan, err := links.PlanRename(context.Background(), ov.Indexer.DB(), ov.FS, from, to)
	return plan, bindingError(err)
}

// ApplyRename renames or moves from → to, rewriting links in other notes.
// It re-plans against the current content, so it is safe to call after a
// preview even if notes changed meanwhile; the whole operation is all or nothing.
func (l *LinksAPI) ApplyRename(vaultID, from, to string) (links.Plan, error) {
	if err := l.app.writable(vaultID); err != nil {
		return links.Plan{}, err
	}
	ov, err := l.app.vault(vaultID)
	if err != nil {
		return links.Plan{}, err
	}
	ctx := context.Background()
	plan, err := links.PlanRename(ctx, ov.Indexer.DB(), ov.FS, from, to)
	if err != nil {
		return plan, bindingError(err)
	}
	if err := links.ApplyRename(ov.FS, plan); err != nil {
		return plan, bindingError(err)
	}
	// Keep the file identity for synchronization even though the note's own
	// content may have been rewritten by the link updates.
	l.app.sync.Renamed(ctx, vaultID, plan.From, plan.To)
	touched := []string{plan.From, plan.To}
	for _, f := range plan.Files {
		touched = append(touched, f.Path)
	}
	return plan, ov.Indexer.Update(ctx, touched)
}

// Resolve returns the vault path a link written in fromPath points to ("" when unresolved).
func (l *LinksAPI) Resolve(vaultID, fromPath, target string) (string, error) {
	ov, err := l.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	r, err := links.Load(context.Background(), ov.Indexer.DB())
	if err != nil {
		return "", err
	}
	return r.Resolve(fromPath, target), nil
}

// Suggest returns completion candidates. kind is "notes" (titles, paths,
// aliases), "headings" (of notePath, or of every note when empty), "blocks"
// (ids in notePath), "tags", "properties" or "all" (notes + headings, for the
// quick switcher).
func (l *LinksAPI) Suggest(vaultID, kind, query, notePath string, limit int) ([]links.Suggestion, error) {
	ov, err := l.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	ctx, db := context.Background(), ov.Indexer.DB()
	switch kind {
	case "notes":
		return links.SuggestNotes(ctx, db, query, limit)
	case "headings":
		return links.SuggestHeadings(ctx, db, notePath, query, limit)
	case "blocks":
		return links.SuggestBlocks(ctx, db, notePath, query, limit)
	case "tags":
		return links.SuggestTags(ctx, db, query, limit)
	case "properties":
		return links.SuggestPropertyKeys(ctx, db, query, limit)
	case "all":
		notes, err := links.SuggestNotes(ctx, db, query, limit)
		if err != nil {
			return nil, err
		}
		if len([]rune(query)) < 2 {
			return notes, nil
		}
		heads, err := links.SuggestHeadings(ctx, db, "", query, limit)
		if err != nil {
			return nil, err
		}
		all := make([]links.Suggestion, 0, len(notes)+len(heads))
		all = append(all, notes...)
		all = append(all, heads...)
		sort.SliceStable(all, func(i, j int) bool { return all[i].Score > all[j].Score })
		if limit > 0 && len(all) > limit {
			all = all[:limit]
		}
		return all, nil
	}
	return nil, fmt.Errorf("invalid: unknown suggestion kind %q", kind)
}
