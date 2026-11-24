package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
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
	// Path is where the file is: in the vault for Source "vault" (the path a tab opens to edit the
	// template), in the library mount for Source "library".
	Path string `json:"path"`
	// Rel is the path inside the templates folder (sub-folders included), for the label.
	Rel string `json:"rel"`
	// Kind is what the template creates: "note" (.md), "drawing" (.excalidraw) or "presentation" (.marp).
	Kind string `json:"kind"`
	// Source is "vault" or "library" (the read-only template library of the group).
	Source string `json:"source"`
	// Ref identifies the template in settings and in the other calls.
	Ref string `json:"ref"`
	// Library is the name of the library mount for Source "library".
	Library string `json:"library"`
}

func templateInfo(tp templates.Template, library string) TemplateInfo {
	return TemplateInfo{Name: tp.Name, Path: tp.Path, Rel: tp.Rel, Kind: tp.Kind, Source: tp.Source, Ref: tp.Ref, Library: library}
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
	// The keys the core writes (the outcome of the move of the templates) are the core's: a frontend
	// that saves the settings it loaded before a migration (made here, or by another device and
	// received by the sync) must not take them away, or the references to the folder the templates
	// left would stop resolving.
	var incoming map[string]json.RawMessage
	if err := json.Unmarshal([]byte(content), &incoming); err == nil && incoming != nil {
		stored := t.app.dailySettings(ov)
		changed := false
		for _, key := range []string{keyTemplatesMigrated, keyTemplatesMigratedFrom} {
			if v, ok := stored.keys[key]; ok && !stored.invalid && string(incoming[key]) != string(v) {
				incoming[key], changed = v, true
			}
		}
		if changed {
			if data, err := json.MarshalIndent(incoming, "", "  "); err == nil {
				content = string(data)
			}
		}
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

// List returns the templates of the vault (the notes, drawings and presentations of the templates
// folder of its configuration folder, ADR-0068) plus those of the group library when it is mounted.
func (t *TemplatesAPI) List(vaultID string) ([]TemplateInfo, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	own, err := templates.List(ov.FS)
	if err != nil {
		return nil, bindingError(err)
	}
	out := make([]TemplateInfo, 0, len(own))
	for _, tp := range own {
		out = append(out, templateInfo(tp, ""))
	}
	if lib, name, ok := t.app.library(); ok {
		if shared, err := templates.ListLibrary(lib); err == nil {
			for _, tp := range shared {
				out = append(out, templateInfo(tp, name))
			}
		}
	}
	return out, nil
}

var errNotATemplate = errors.New("invalid: a template is a note (.md), a drawing (.excalidraw) or a presentation (.marp)")

// readTemplate returns the text of a template reference and its kind ("" ref = empty template, no kind).
//
// A reference of the vault is a path. One inside the templates folder is read through the
// configuration folder, under whichever name the vault keeps it (vault.FS.ReadConfig). Any other
// path is a file of the vault: the references written up to 1.8, when the templates were notes of a
// folder of the vault, and the ones the administrator manages (daily_notes.template). Once that
// folder has been moved (Migrate), a reference into it that finds no file is read from the place
// the file went to.
func (a *App) readTemplate(ov *openVault, ref string) (text, kind string, err error) {
	if ref == "" {
		return "", "", nil
	}
	source, p := templates.ParseRef(ref)
	if kind = templates.KindOfPath(p); kind == "" {
		return "", "", errNotATemplate
	}
	if source == templates.SourceLibrary {
		lib, _, ok := a.library()
		if !ok {
			return "", "", errors.New("not-found: the template library is not mounted")
		}
		c, err := lib.ReadFile(p)
		if err != nil {
			return "", "", bindingError(err)
		}
		return string(c.Data), kind, nil
	}
	norm, err := pathrules.Normalize(p)
	if err != nil {
		return "", "", bindingError(err)
	}
	var c vault.Content
	switch rel, isTemplate := pathrules.TemplateRel(norm); {
	case isTemplate:
		c, err = ov.FS.ReadConfig(templates.ConfigName(rel))
	case pathrules.IsConfigPath(norm):
		return "", "", errNotATemplate // a settings file is never a template
	default:
		if c, err = ov.FS.ReadFile(norm); errors.Is(err, fs.ErrNotExist) {
			if rest, moved := pathrules.Rebase(norm, a.dailySettings(ov).migratedFrom(), ""); moved && rest != "" {
				c, err = ov.FS.ReadConfig(templates.ConfigName(rest))
			}
		}
	}
	if err != nil {
		return "", "", bindingError(err)
	}
	return string(c.Data), kind, nil
}

// Expand returns the text of a template with its variables replaced for a file called title. A
// drawing has no variables: it is returned as it is.
func (t *TemplatesAPI) Expand(vaultID, ref, title, lang string) (string, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	src, kind, err := t.app.readTemplate(ov, ref)
	if err != nil {
		return "", err
	}
	if kind == templates.KindDrawing {
		return src, nil
	}
	return templates.Expand(src, templates.ExpandOptions{Now: time.Now(), Title: title, Lang: lang}), nil
}

// createNoteFrom writes a new note whose content is an expanded template (or empty).
func (a *App) createNoteFrom(ov *openVault, notePath, ref string, now time.Time, lang string) error {
	content := ""
	if ref != "" {
		src, kind, err := a.readTemplate(ov, ref)
		if err == nil && kind != templates.KindNote {
			err = fmt.Errorf("invalid: a %s is not the template of a note", kind)
		}
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
	if _, p := templates.ParseRef(ref); ref != "" && templates.KindOfPath(p) != templates.KindNote {
		return "", errors.New("invalid: a note is created from the template of a note (.md)")
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

// errTemplatesOfMount refuses to add a template to a mount: its configuration folder is a folder of
// the share (the sync addresses it relative to the root of the share), so the file would reach the
// owner and every other recipient as an ordinary note or drawing of the shared folder.
var errTemplatesOfMount = errors.New("read-only: a folder shared with you keeps no templates of its own; create them in a vault of yours")

// maxTemplateBytes bounds the content of a new template (a drawing with images can be large).
const maxTemplateBytes = 32 << 20

// Create adds a template of the given kind ("note", "drawing", "presentation") to the templates
// folder of the vault, with content as its text, and returns it: "New template" and "Save as
// template". The name gets a numeric suffix when it is taken; nothing is overwritten.
func (t *TemplatesAPI) Create(vaultID, name, kind, content string) (TemplateInfo, error) {
	if err := t.app.writable(vaultID); err != nil {
		return TemplateInfo{}, err
	}
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return TemplateInfo{}, err
	}
	if _, mount := t.app.sync.MountOfVault(context.Background(), vaultID); mount {
		return TemplateInfo{}, errTemplatesOfMount
	}
	ext := templates.ExtOfKind(kind)
	if ext == "" {
		return TemplateInfo{}, fmt.Errorf("invalid: unknown kind of template %q", kind)
	}
	if len(content) > maxTemplateBytes {
		return TemplateInfo{}, errors.New("invalid: the template is too large")
	}
	if kind == templates.KindDrawing && !json.Valid([]byte(content)) {
		return TemplateInfo{}, errors.New("invalid: the template of a drawing must be a drawing")
	}
	if strings.EqualFold(path.Ext(name), ext) {
		name = name[:len(name)-len(ext)]
	}
	stem := composer.SanitizeTitle(name)
	if stem == "" {
		stem = "Untitled"
	}
	for n := 1; ; n++ {
		rel := stem + ext
		if n > 1 {
			rel = fmt.Sprintf("%s %d%s", stem, n, ext)
		}
		if err := portableName(templates.ConfigName(rel)); err != nil {
			return TemplateInfo{}, err
		}
		c, err := ov.FS.WriteConfig(templates.ConfigName(rel), []byte(content), "", true)
		if errors.Is(err, vault.ErrExists) && n < 1000 {
			continue
		}
		if err != nil {
			return TemplateInfo{}, bindingError(err)
		}
		t.app.refreshIndex(ov, c.Path)
		return templateInfo(templates.Template{
			Name: strings.TrimSuffix(rel, ext), Path: c.Path, Rel: rel, Kind: kind,
			Source: templates.SourceVault, Ref: templates.VaultRef(rel),
		}, ""), nil
	}
}

// Keys of daily.json the core reads and writes itself; the others are the frontend's.
const (
	keyTemplatesFolder       = "templatesFolder"       // up to 1.8: the folder of the vault the templates were in
	keyTemplatesMigrated     = "templatesMigrated"     // the templates of that folder were offered the move
	keyTemplatesMigratedFrom = "templatesMigratedFrom" // the folder they were moved from
)

// templateRefKeys are the settings of daily.json that hold a template reference.
var templateRefKeys = []string{"dailyTemplate", "uniqueTemplate", "newNoteTemplate", "newDrawingTemplate", "newPresentationTemplate"}

// dailyFile is daily.json as stored: every key kept as it is, the unknown ones included.
type dailyFile struct {
	keys map[string]json.RawMessage
	hash string // "" when the file does not exist
	// invalid: the file exists and is not a JSON object (edited by hand). It is read as empty and
	// never written over by the core: the user's text is the only copy.
	invalid bool
}

var errDailyInvalid = errors.New("invalid: daily.json of this vault is not valid JSON; fix or delete it first")

func (d dailyFile) text(key string) string {
	var s string
	_ = json.Unmarshal(d.keys[key], &s)
	return s
}

func (d dailyFile) flag(key string) bool {
	var b bool
	_ = json.Unmarshal(d.keys[key], &b)
	return b
}

// migratedFrom is the normalized folder the templates were moved from, "" when they were not.
func (d dailyFile) migratedFrom() string {
	from := strings.Trim(d.text(keyTemplatesMigratedFrom), "/")
	if from == "" {
		return "\x00" // matches no path (an empty prefix would match them all)
	}
	norm, err := pathrules.Normalize(from)
	if err != nil {
		return "\x00"
	}
	return norm
}

// dailySettings reads daily.json; a missing or unreadable file is an empty one.
func (a *App) dailySettings(ov *openVault) dailyFile {
	d := dailyFile{keys: map[string]json.RawMessage{}}
	c, err := ov.FS.ReadConfig(dailySettingsFile)
	if err != nil {
		return d
	}
	d.hash = c.Hash
	if err := json.Unmarshal(c.Data, &d.keys); err != nil || d.keys == nil {
		d.keys = map[string]json.RawMessage{} // a hand-edited file must not break the app
		d.invalid = true
	}
	return d
}

// Reasons a migration of the templates cannot run now (TemplateMigration.Blocked).
const (
	MigrationBlockedReadOnly = "read-only"     // the user may not change the vault
	MigrationBlockedMount    = "mount"         // the vault is a folder shared with the user
	MigrationBlockedShared   = "shared-folder" // the folder is shared with others, or holds or is inside a share
	MigrationBlockedOffline  = "offline"       // the shares of the vault could not be read: try again later
)

// TemplateMigration is the move of the templates of a vault from the folder they were in up to 1.8
// to the templates folder of its configuration folder (ADR-0068): what MigrationPlan would move and
// what Migrate moved.
type TemplateMigration struct {
	// Folder is the folder the templates are (or were) in.
	Folder string `json:"folder"`
	// Files are the notes, drawings and presentations of Folder: what a migration moves.
	Files []string `json:"files"`
	// Moved counts the files Migrate moved.
	Moved int `json:"moved"`
	// Skipped are the files Migrate left where they were (a template of that name exists already).
	Skipped []string `json:"skipped"`
	// Paths maps each file Migrate moved to where it is now, for the tabs open on them.
	Paths map[string]string `json:"paths"`
	// Blocked is why the migration cannot run now ("" when it can); nothing was changed.
	Blocked string `json:"blocked"`
	// Done reports that the vault needs no migration any more: it was offered and answered.
	Done bool `json:"done"`
}

// migrationPlan computes what a migration would move and whether it may run. ignoreDone plans a
// vault whose migration was already answered (the "Import templates from the folder" command).
func (a *App) migrationPlan(ctx context.Context, vaultID string, ov *openVault, ignoreDone bool) (TemplateMigration, error) {
	d := a.dailySettings(ov)
	plan := TemplateMigration{Files: []string{}, Skipped: []string{}, Paths: map[string]string{}}
	if d.invalid {
		return plan, errDailyInvalid
	}
	if d.flag(keyTemplatesMigrated) && !ignoreDone {
		plan.Done = true
		return plan, nil
	}
	// A folder shared with the user is never migrated nor marked: its configuration folder is a
	// folder of the share, and what is written there reaches the owner and the other recipients.
	// The link of the vault is read strictly: when it cannot be read the vault is not taken for one
	// of the user's own that is not connected.
	info, err := a.sync.InfoStrict(ctx, vaultID)
	switch {
	case err != nil:
		plan.Blocked = MigrationBlockedOffline
		return plan, nil
	case info.ReadOnly || a.writable(vaultID) != nil:
		plan.Blocked = MigrationBlockedReadOnly
		return plan, nil
	case info.Mount || a.isMount(ctx, vaultID):
		plan.Blocked = MigrationBlockedMount
		return plan, nil
	}
	folder := d.text(keyTemplatesFolder)
	if strings.Trim(folder, "/") == "" {
		folder = d.text(keyTemplatesMigratedFrom) // "" again: the default folder
	}
	norm, files, err := templates.FolderFiles(ov.FS, folder)
	if err != nil {
		return plan, bindingError(err)
	}
	plan.Folder = norm
	if len(files) == 0 {
		return plan, nil // nothing to move: no share can be in the way
	}
	plan.Files = files
	plan.Blocked = a.sharedFolderBlock(ctx, vaultID, info, norm)
	return plan, nil
}

func (a *App) isMount(ctx context.Context, vaultID string) bool {
	_, mount := a.sync.MountOfVault(ctx, vaultID)
	return mount
}

// sharedFolderBlock tells whether folder may not be emptied because of a share: it is one, holds
// one or is inside one. The server refuses the move of the last file out of a shared folder
// (SHARE_ROOT_MOVE), and the recipients (a group template library is such a share) would lose the
// files. A vault that is not connected, or is private, has no shares; when the shares cannot be
// read the answer is "offline", never "go ahead".
func (a *App) sharedFolderBlock(ctx context.Context, vaultID string, info syncpkg.LinkInfo, folder string) string {
	if !info.Linked || info.Kind != "shared" {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, sharingCallTimeout)
	defer cancel()
	shares, err := a.sync.VaultShares(ctx, vaultID)
	if err != nil {
		return MigrationBlockedOffline
	}
	key := pathrules.Key(folder)
	for _, sh := range shares {
		if sh.PathPrefix == nil || *sh.PathPrefix == "" {
			continue // the whole vault, or a document (it follows its file wherever it goes)
		}
		prefix := pathrules.Key(*sh.PathPrefix)
		if pathrules.HasPrefix(key, prefix) || pathrules.HasPrefix(prefix, key) {
			return MigrationBlockedShared
		}
	}
	return ""
}

// MigrationPlan tells what moving the templates of the vault to its templates folder would move,
// without changing anything. Done is set once the move was made or declined; Blocked says why it
// cannot run now (the vault is read-only, a mount, the folder is shared, the shares are unknown).
func (t *TemplatesAPI) MigrationPlan(vaultID string) (TemplateMigration, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return TemplateMigration{}, err
	}
	plan, err := t.app.migrationPlan(context.Background(), vaultID, ov, false)
	return plan, err
}

// Migrate moves the notes, drawings and presentations of the folder the templates were in up to
// 1.8 to the templates folder of the vault, each as the same file for the sync (a move, not a
// delete and a create), and rewrites the references to them in daily.json. Nothing is overwritten:
// a file whose name is taken stays where it is (Skipped), and its references keep working. The
// other files of the folder (images, say) stay; the folder goes when the move leaves it empty.
// It runs again on a vault already migrated (the "Import templates from the folder" command). A
// blocked migration changes nothing and says why.
func (t *TemplatesAPI) Migrate(vaultID string) (TemplateMigration, error) {
	ctx := context.Background()
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return TemplateMigration{}, err
	}
	plan, err := t.app.migrationPlan(ctx, vaultID, ov, true)
	if err != nil || plan.Blocked != "" {
		return plan, err
	}
	if err := t.app.writable(vaultID); err != nil {
		return TemplateMigration{}, err
	}
	refs := map[string]string{} // old reference (the path) -> new reference
	for _, from := range plan.Files {
		rel, _ := pathrules.Rebase(from, plan.Folder, "")
		name := templates.ConfigName(rel)
		if _, err := pathrules.NormalizePortable(name); err != nil {
			plan.Skipped = append(plan.Skipped, from)
			continue
		}
		to, err := ov.FS.AdoptConfig(from, name)
		if err != nil {
			if !errors.Is(err, vault.ErrExists) {
				t.app.logger.Warn().Err(err).Str("path", from).Msg("templates: a file could not be moved")
			}
			plan.Skipped = append(plan.Skipped, from)
			continue
		}
		t.app.sync.Renamed(ctx, vaultID, from, to)
		t.app.refreshIndex(ov, from, to)
		refs[from] = templates.VaultRef(rel)
		plan.Paths[from] = to
		plan.Moved++
		// Only the folders this file left empty go, up to the folder of the templates: an empty
		// folder the user made stays.
		if err := ov.FS.PruneEmptyParents(from, plan.Folder); err != nil {
			t.app.logger.Warn().Err(err).Str("path", from).Msg("templates: an emptied folder could not be removed")
		}
	}
	if err := t.app.markMigrated(ov, plan, refs); err != nil {
		return plan, err
	}
	plan.Done = true
	return plan, nil
}

// DeclineMigration records that the user was offered the move of the templates and said no: it is
// not offered again. The templates stay where they are and their references keep working.
func (t *TemplatesAPI) DeclineMigration(vaultID string) error {
	if err := t.app.writable(vaultID); err != nil {
		return err
	}
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return err
	}
	if t.app.isMount(context.Background(), vaultID) {
		return nil // never offered there, nothing to record
	}
	return t.app.markMigrated(ov, TemplateMigration{}, nil)
}

// markMigrated writes the outcome of a migration to daily.json: the references to the files moved,
// the folder they came from, and the mark that keeps the move from being offered again. The file is
// written against the content it was read with, so a setting the frontend saved meanwhile is not
// lost: the write is tried again on the new content.
func (a *App) markMigrated(ov *openVault, plan TemplateMigration, refs map[string]string) error {
	for attempt := 1; ; attempt++ {
		d := a.dailySettings(ov)
		if d.invalid {
			return errDailyInvalid
		}
		for _, key := range templateRefKeys {
			if to, ok := refs[d.text(key)]; ok {
				d.keys[key], _ = json.Marshal(to)
			}
		}
		if plan.Moved > 0 {
			delete(d.keys, keyTemplatesFolder)
			d.keys[keyTemplatesMigratedFrom], _ = json.Marshal(plan.Folder)
		}
		d.keys[keyTemplatesMigrated] = json.RawMessage("true")
		data, err := json.MarshalIndent(d.keys, "", "  ")
		if err != nil {
			return bindingError(err)
		}
		_, err = ov.FS.WriteConfig(dailySettingsFile, data, d.hash, d.hash == "")
		if err == nil {
			return nil
		}
		retry := errors.Is(err, vault.ErrHashMismatch) || errors.Is(err, vault.ErrExists)
		if attempt >= 3 || !retry {
			return bindingError(err)
		}
	}
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
