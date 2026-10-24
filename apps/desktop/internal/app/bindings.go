package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"nodus/apps/desktop/internal/links"
	"nodus/apps/desktop/internal/search"
	"nodus/apps/desktop/internal/vault"
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
	return runtime.OpenDirectoryDialog(v.app.ctx, runtime.OpenDialogOptions{Title: title, CanCreateDirectories: true})
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
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return err
	}
	return bindingError(ov.FS.Mkdir(relPath))
}

// Rename moves a file or folder. Link rewriting (RenameWithLinkUpdate) arrives in M1-WP3.
func (v *VaultAPI) Rename(vaultID, fromPath, toPath string) error {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return err
	}
	if err := ov.FS.Rename(fromPath, toPath); err != nil {
		return bindingError(err)
	}
	return ov.Indexer.Update(context.Background(), []string{fromPath, toPath})
}

// Trash moves a file or folder to the vault's .trash/ folder and returns its new path.
func (v *VaultAPI) Trash(vaultID, relPath string) (string, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	dest, err := ov.FS.Trash(relPath)
	if err != nil {
		return "", bindingError(err)
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
}

// Get returns the saved preferences (defaults when unset).
func (s *SettingsAPI) Get() (AppSettings, error) {
	out := AppSettings{Theme: "system"}
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
	raw, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = s.app.appDB.ExecContext(s.app.ctx, `INSERT INTO app_settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, string(raw))
	return err
}

// Info returns build and environment facts for the About panel.
func (s *SettingsAPI) Info() map[string]string {
	return map[string]string{
		"version": s.app.opts.Version,
		"dataDir": s.app.opts.DataDir,
		// Convenience for development: NODUS_DEFAULT_SERVER_URL prefills the sign-in form.
		"defaultServer": os.Getenv("NODUS_DEFAULT_SERVER_URL"),
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
	touched := []string{plan.From, plan.To}
	for _, f := range plan.Files {
		touched = append(touched, f.Path)
	}
	return plan, ov.Indexer.Update(ctx, touched)
}
