package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"
	"time"

	"clarae/apps/desktop/internal/composer"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/templates"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
)

// dailySettingsFile holds the per-vault settings of daily notes, unique notes and
// templates (the frontend resolves them with the managed configuration).
const dailySettingsFile = "daily.json"

// TemplatesAPI exposes templates, daily notes and unique notes.
type TemplatesAPI struct{ app *App }

// NewTemplatesAPI binds the API.
func NewTemplatesAPI(a *App) *TemplatesAPI { return &TemplatesAPI{app: a} }

// TemplateInfo is a template as the UI lists it.
type TemplateInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Source is "vault" or "library" (the read-only template library of the group).
	Source string `json:"source"`
	// Ref identifies the template in settings and in the other calls.
	Ref string `json:"ref"`
	// Library is the name of the library mount for Source "library".
	Library string `json:"library"`
}

// NoteResult is a note created or found by one of the calls below.
type NoteResult struct {
	Path    string `json:"path"`
	Created bool   `json:"created"`
}

// DailyOptions select the daily note to open.
type DailyOptions struct {
	// Date is the day, YYYY-MM-DD in local time ("" = today).
	Date     string `json:"date"`
	Folder   string `json:"folder"`
	Format   string `json:"format"`
	Template string `json:"template"`
	Lang     string `json:"lang"`
}

// UniqueOptions describe a new unique note.
type UniqueOptions struct {
	Folder   string `json:"folder"`
	Format   string `json:"format"`
	Template string `json:"template"`
	Lang     string `json:"lang"`
}

// ReadSettings returns the stored daily/template settings ("" when none).
func (t *TemplatesAPI) ReadSettings(vaultID string) (string, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	c, err := ov.FS.ReadConfig(dailySettingsFile)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(c.Data), nil
}

// WriteSettings stores the daily/template settings (valid JSON).
func (t *TemplatesAPI) WriteSettings(vaultID, content string) error {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return err
	}
	if !json.Valid([]byte(content)) {
		return errors.New("invalid: content is not valid JSON")
	}
	_, err = ov.FS.WriteConfig(dailySettingsFile, []byte(content), "", false)
	return bindingError(err)
}

var uuidLike = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)

// library opens the group template library: the share named by `templates.library_share_id`
// in the managed configuration, when it is mounted on this device. ok is false when the
// configuration names none or the mount is absent. The mount is only ever read.
func (a *App) library() (fsys *vault.FS, name string, ok bool) {
	sec, _ := a.config.Current().Config["templates"].(map[string]any)
	id, _ := sec["library_share_id"].(string)
	if id == "" || !uuidLike.MatchString(id) {
		return nil, "", false
	}
	dir := syncpkg.MountDir(a.mountsDir(), id)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil, "", false
	}
	fsys, err := vault.NewFS(dir)
	if err != nil {
		return nil, "", false
	}
	name = id
	if mm, found, _ := syncpkg.ReadMount(context.Background(), dir); found && mm.Name != "" {
		name = mm.Name
	}
	return fsys, name, true
}

// List returns the templates of the vault's template folder plus those of the group
// library when it is mounted.
func (t *TemplatesAPI) List(vaultID, folder string) ([]TemplateInfo, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	own, err := templates.List(ov.FS, folder, templates.SourceVault, false)
	if err != nil {
		return nil, err
	}
	out := make([]TemplateInfo, 0, len(own))
	for _, tp := range own {
		out = append(out, TemplateInfo{Name: tp.Name, Path: tp.Path, Source: tp.Source, Ref: tp.Ref})
	}
	if lib, name, ok := t.app.library(); ok {
		if shared, err := templates.List(lib, "", templates.SourceLibrary, true); err == nil {
			for _, tp := range shared {
				out = append(out, TemplateInfo{Name: tp.Name, Path: tp.Path, Source: tp.Source, Ref: tp.Ref, Library: name})
			}
		}
	}
	return out, nil
}

// readTemplate returns the text of a template reference ("" ref = empty template).
func (a *App) readTemplate(ov *openVault, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	source, p := templates.ParseRef(ref)
	fsys := ov.FS
	if source == templates.SourceLibrary {
		lib, _, ok := a.library()
		if !ok {
			return "", errors.New("not-found: the template library is not mounted")
		}
		fsys = lib
	}
	if !strings.EqualFold(path.Ext(p), ".md") {
		return "", errors.New("invalid: a template must be a Markdown note")
	}
	c, err := fsys.ReadFile(p)
	if err != nil {
		return "", bindingError(err)
	}
	return string(c.Data), nil
}

// Expand returns the text of a template with its variables replaced for a note called title.
func (t *TemplatesAPI) Expand(vaultID, ref, title, lang string) (string, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	src, err := t.app.readTemplate(ov, ref)
	if err != nil {
		return "", err
	}
	return templates.Expand(src, templates.ExpandOptions{Now: time.Now(), Title: title, Lang: lang}), nil
}

// createNoteFrom writes a new note whose content is an expanded template (or empty).
func (a *App) createNoteFrom(ov *openVault, notePath, ref string, now time.Time, lang string) error {
	content := ""
	if ref != "" {
		src, err := a.readTemplate(ov, ref)
		if err != nil {
			// A missing template must not stop the note from being created.
			a.logger.Warn().Err(err).Str("template", ref).Msg("template unavailable; creating an empty note")
		} else {
			content = templates.Expand(src, templates.ExpandOptions{Now: now, Title: templates.TitleOf(notePath), Lang: lang})
		}
	}
	if _, err := ov.FS.WriteFile(notePath, []byte(content), "", true); err != nil {
		return bindingError(err)
	}
	_ = ov.Indexer.Update(context.Background(), []string{notePath})
	return nil
}

// OpenDaily returns the daily note of a day, creating it from the template when it
// does not exist yet (the vault must be writable only for that creation).
func (t *TemplatesAPI) OpenDaily(vaultID string, o DailyOptions) (NoteResult, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return NoteResult{}, err
	}
	now := time.Now()
	day := now
	if o.Date != "" {
		d, err := time.ParseInLocation("2006-01-02", o.Date, time.Local)
		if err != nil {
			return NoteResult{}, fmt.Errorf("invalid: date %q is not YYYY-MM-DD", o.Date)
		}
		// The day comes from the argument, the clock from now ({{time}}).
		day = time.Date(d.Year(), d.Month(), d.Day(), now.Hour(), now.Minute(), now.Second(), 0, time.Local)
	}
	p := templates.DailyPath(o.Folder, o.Format, o.Lang, day)
	p, err = pathrules.Normalize(p)
	if err != nil {
		return NoteResult{}, bindingError(err)
	}
	if _, err := ov.FS.ReadFile(p); err == nil {
		return NoteResult{Path: p}, nil
	}
	if err := t.app.writable(vaultID); err != nil {
		return NoteResult{}, err
	}
	if err := t.app.createNoteFrom(ov, p, o.Template, day, o.Lang); err != nil {
		return NoteResult{}, err
	}
	return NoteResult{Path: p, Created: true}, nil
}

// DailyAdjacent returns the day (YYYY-MM-DD) delta days from the daily note at notePath,
// or "" when that note is not a daily note under the given folder and format.
func (t *TemplatesAPI) DailyAdjacent(notePath, folder, format, lang string, delta int) string {
	return templates.AdjacentDay(notePath, folder, format, lang, delta, time.Local)
}

// NewUnique creates a note named with a timestamp (and the template applied).
func (t *TemplatesAPI) NewUnique(vaultID string, o UniqueOptions) (NoteResult, error) {
	if err := t.app.writable(vaultID); err != nil {
		return NoteResult{}, err
	}
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return NoteResult{}, err
	}
	now := time.Now()
	exists := func(p string) bool {
		_, err := ov.FS.ReadFile(p)
		return err == nil
	}
	p := templates.UniquePath(o.Folder, o.Format, o.Lang, now, exists)
	p, err = pathrules.Normalize(p)
	if err != nil {
		return NoteResult{}, bindingError(err)
	}
	if err := t.app.createNoteFrom(ov, p, o.Template, now, o.Lang); err != nil {
		return NoteResult{}, err
	}
	return NoteResult{Path: p, Created: true}, nil
}

// CreateFromTemplate creates note `name` in dir (a numeric suffix avoids a clash) with the
// expanded template and returns its path.
func (t *TemplatesAPI) CreateFromTemplate(vaultID, dir, name, ref, lang string) (string, error) {
	if err := t.app.writable(vaultID); err != nil {
		return "", err
	}
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	name = composer.SanitizeTitle(strings.TrimSuffix(name, ".md"))
	if name == "" {
		name = "Untitled"
	}
	dir = strings.Trim(dir, "/")
	var p string
	for n := 1; ; n++ {
		stem := name
		if n > 1 {
			stem = fmt.Sprintf("%s %d", name, n)
		}
		p = stem + ".md"
		if dir != "" {
			p = dir + "/" + p
		}
		if _, err := ov.FS.ReadFile(p); err != nil {
			break
		}
	}
	norm, err := pathrules.Normalize(p)
	if err != nil {
		return "", bindingError(err)
	}
	if err := t.app.createNoteFrom(ov, norm, ref, time.Now(), lang); err != nil {
		return "", err
	}
	return norm, nil
}

// ComposerAPI exposes the note composer: merge notes and extract a selection.
type ComposerAPI struct{ app *App }

// NewComposerAPI binds the API.
func NewComposerAPI(a *App) *ComposerAPI { return &ComposerAPI{app: a} }

func (c *ComposerAPI) env(ov *openVault) composer.Env {
	return composer.Env{
		FS: ov.FS,
		DB: ov.Indexer.DB(),
		Trash: func(p string) error {
			_, err := NewVaultAPI(c.app).Trash(ov.Info.ID, p)
			return err
		},
		Reindex: func(paths []string) { _ = ov.Indexer.Update(context.Background(), paths) },
	}
}

// PlanMerge previews merging source into target: how many links in how many notes would be
// redirected. Nothing is changed.
func (c *ComposerAPI) PlanMerge(vaultID, source, target string) (composer.MergePlan, error) {
	ov, err := c.app.vault(vaultID)
	if err != nil {
		return composer.MergePlan{}, err
	}
	plan, err := composer.PlanMerge(context.Background(), c.env(ov), source, target)
	return plan, bindingError(err)
}

// ApplyMerge appends source to target, redirects the links to source and trashes it.
// separator is "heading" (default), "rule" or "none". On a trash failure the result is
// returned together with an error (the merge itself is complete).
func (c *ComposerAPI) ApplyMerge(vaultID, source, target, separator string) (composer.MergeResult, error) {
	if err := c.app.writable(vaultID); err != nil {
		return composer.MergeResult{}, err
	}
	ov, err := c.app.vault(vaultID)
	if err != nil {
		return composer.MergeResult{}, err
	}
	res, err := composer.ApplyMerge(context.Background(), c.env(ov), source, target, composer.MergeOptions{Separator: separator})
	return res, bindingError(err)
}

// SuggestTitle proposes a note title for a selection.
func (c *ComposerAPI) SuggestTitle(selection string) string { return composer.SuggestTitle(selection) }

// Extract creates a new note from a selection and returns it with the text that replaces the
// selection in the editor.
func (c *ComposerAPI) Extract(vaultID string, o composer.ExtractOptions) (composer.ExtractResult, error) {
	if err := c.app.writable(vaultID); err != nil {
		return composer.ExtractResult{}, err
	}
	ov, err := c.app.vault(vaultID)
	if err != nil {
		return composer.ExtractResult{}, err
	}
	res, err := composer.Extract(ov.FS, o)
	if err != nil {
		return composer.ExtractResult{}, bindingError(err)
	}
	_ = ov.Indexer.Update(context.Background(), []string{res.Path})
	return res, nil
}
