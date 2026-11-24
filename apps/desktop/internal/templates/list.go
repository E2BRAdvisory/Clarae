package templates

import (
	"errors"
	"io/fs"
	"path"
	"sort"
	"strings"

	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
)

// The templates of a vault live in one place, the folder pathrules.TemplatesDir of its
// configuration folder (ADR-0068): they sync with the vault, per user, and are neither indexed nor
// listed with the notes. DefaultFolder is where they were up to 1.8, a folder of the vault the user
// could rename: it is only read to move its templates (the migration of the bindings).
const DefaultFolder = "Templates"

// Sources of a template.
const (
	SourceVault   = "vault"   // a file of the templates folder of the open vault
	SourceLibrary = "library" // a file of the read-only group library mount
)

// Kinds of a template: what it creates. The extension of the file decides.
const (
	KindNote         = "note"         // .md
	KindDrawing      = "drawing"      // .excalidraw
	KindPresentation = "presentation" // .marp
)

// LibraryPrefix marks a template reference that points into the group library.
const LibraryPrefix = "library:"

// KindOfPath is the kind of the template at a path, "" when the file is not a template.
func KindOfPath(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".md":
		return KindNote
	case ".excalidraw":
		return KindDrawing
	case ".marp":
		return KindPresentation
	}
	return ""
}

// ExtOfKind is the extension of the templates of a kind, "" for an unknown kind.
func ExtOfKind(kind string) string {
	switch kind {
	case KindNote:
		return ".md"
	case KindDrawing:
		return ".excalidraw"
	case KindPresentation:
		return ".marp"
	}
	return ""
}

// Template is a file usable as template.
type Template struct {
	// Name is the file name without extension.
	Name string `json:"name"`
	// Path is where the file is: relative to the vault, or to the library root for SourceLibrary.
	Path string `json:"path"`
	// Rel is the path inside the templates folder (the whole path for SourceLibrary).
	Rel string `json:"rel"`
	// Kind is KindNote, KindDrawing or KindPresentation.
	Kind string `json:"kind"`
	// Source is SourceVault or SourceLibrary.
	Source string `json:"source"`
	// Ref is the string that identifies the template in settings: VaultRef(Rel) for the vault,
	// "library:<path>" for the library.
	Ref string `json:"ref"`
}

// ParseRef splits a template reference into its source and path.
func ParseRef(ref string) (source, p string) {
	if rest, ok := strings.CutPrefix(ref, LibraryPrefix); ok {
		return SourceLibrary, rest
	}
	return SourceVault, ref
}

// RefFor builds the reference of a template.
func RefFor(source, p string) string {
	if source == SourceLibrary {
		return LibraryPrefix + p
	}
	return p
}

// VaultRef is the reference of the template of the vault at rel inside the templates folder. It is
// spelled with the current name of the configuration folder wherever the file is (a vault shared
// with a 1.x client keeps it under the former name): the reader resolves it (ConfigName).
func VaultRef(rel string) string {
	return pathrules.ConfigDir + "/" + pathrules.TemplatesDir + "/" + rel
}

// ConfigName is the name of a template inside the configuration folder, as vault.FS.ReadConfig and
// WriteConfig take it.
func ConfigName(rel string) string { return pathrules.TemplatesDir + "/" + rel }

func nameOf(p string) string { return strings.TrimSuffix(path.Base(p), path.Ext(p)) }

func sortTemplates(out []Template) {
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Rel), strings.ToLower(out[j].Rel)
		if a != b {
			return a < b
		}
		return out[i].Rel < out[j].Rel
	})
}

// List returns the templates of the vault: the notes, drawings and presentations of its templates
// folder (recursively), sorted by path. A vault without the folder has none.
func List(fsys *vault.FS) ([]Template, error) {
	out := []Template{}
	err := fsys.WalkConfig(pathrules.TemplatesDir, func(rel string, e vault.Entry) error {
		kind := KindOfPath(rel)
		if kind == "" {
			return nil
		}
		out = append(out, Template{Name: nameOf(rel), Path: e.Path, Rel: rel, Kind: kind, Source: SourceVault, Ref: VaultRef(rel)})
		return nil
	})
	sortTemplates(out)
	return out, err
}

// ListLibrary returns the templates of a group library, whose root is the templates folder: every
// note, drawing and presentation of the mount, sorted by path.
func ListLibrary(fsys *vault.FS) ([]Template, error) {
	out := []Template{}
	err := fsys.Walk(func(e vault.Entry) error {
		kind := KindOfPath(e.Path)
		if e.IsDir || kind == "" || outsideNotes(e.Path) {
			return nil
		}
		out = append(out, Template{Name: nameOf(e.Path), Path: e.Path, Rel: e.Path, Kind: kind, Source: SourceLibrary, Ref: RefFor(SourceLibrary, e.Path)})
		return nil
	})
	sortTemplates(out)
	return out, err
}

func outsideNotes(p string) bool {
	return pathrules.HasPrefix(p, pathrules.TrashDir) || pathrules.IsConfigPath(p)
}

// FolderFiles returns the paths of the notes, drawings and presentations under folder of fsys
// (recursively), sorted: what the templates folder of the vault takes from the folder the
// templates were in up to 1.8. An empty folder means DefaultFolder; a missing or invalid one
// holds nothing. normalized is the folder as the paths spell it.
func FolderFiles(fsys *vault.FS, folder string) (normalized string, files []string, err error) {
	folder = strings.Trim(folder, "/")
	if folder == "" {
		folder = DefaultFolder
	}
	normalized, nerr := pathrules.Normalize(folder)
	if nerr != nil || outsideNotes(normalized) {
		return "", nil, nil //nolint:nilerr // an invalid folder name holds no templates
	}
	// Only the folder is visited, not the vault: this runs at every opening of a vault.
	err = fsys.WalkDir(normalized, func(e vault.Entry) error {
		if !e.IsDir && KindOfPath(e.Path) != "" {
			files = append(files, e.Path)
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		err = nil
	}
	sort.Strings(files)
	return normalized, files, err
}
