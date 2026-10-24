package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"nodus/apps/desktop/internal/properties"
	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
)

// vaultConfigFiles is the allow-list of settings files under .nodus/ that the
// frontend may read and write (§3.4.6). Anything else is refused.
var vaultConfigFiles = map[string]bool{
	"editor.json": true, "appearance.json": true, "hotkeys.json": true, "types.json": true,
	"workspace.json": true, "workspaces.json": true, "bookmarks.json": true,
	"excalidraw-library.json": true,
}

// MaxBinaryBytes bounds ReadBinary/SaveAttachment payloads.
const MaxBinaryBytes = 32 << 20

// ReadConfig returns a vault settings file ("" when it does not exist yet).
func (v *VaultAPI) ReadConfig(vaultID, name string) (string, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	if !vaultConfigFiles[name] {
		return "", fmt.Errorf("invalid-path: %q is not a vault setting", name)
	}
	c, err := ov.FS.ReadFile(pathrules.ConfigDir + "/" + name)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(c.Data), nil
}

// WriteConfig stores a vault settings file; the content must be valid JSON
// (and a valid schema for types.json).
func (v *VaultAPI) WriteConfig(vaultID, name, content string) error {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return err
	}
	if !vaultConfigFiles[name] {
		return fmt.Errorf("invalid-path: %q is not a vault setting", name)
	}
	if !json.Valid([]byte(content)) {
		return errors.New("invalid: content is not valid JSON")
	}
	if name == "types.json" {
		if _, err := properties.ParseSchema([]byte(content)); err != nil {
			return err
		}
	}
	_, err = ov.FS.WriteFile(pathrules.ConfigDir+"/"+name, []byte(content), "", false)
	return bindingError(err)
}

// BinaryContent is a file's bytes for display (images, audio, video, PDF).
type BinaryContent struct {
	Path string `json:"path"`
	Mime string `json:"mime"`
	Data string `json:"data"` // base64
	Size int64  `json:"size"`
}

// ReadBinary reads an attachment (up to 32 MB) as base64 with its MIME type.
func (v *VaultAPI) ReadBinary(vaultID, relPath string) (BinaryContent, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return BinaryContent{}, err
	}
	abs, normalized, err := ov.FS.Resolve(relPath)
	if err != nil {
		return BinaryContent{}, bindingError(err)
	}
	st, err := os.Stat(abs)
	if err != nil {
		return BinaryContent{}, bindingError(err)
	}
	if st.Size() > MaxBinaryBytes {
		return BinaryContent{}, fmt.Errorf("too-large: %s is %d bytes (limit %d)", normalized, st.Size(), MaxBinaryBytes)
	}
	c, err := ov.FS.ReadFile(normalized)
	if err != nil {
		return BinaryContent{}, bindingError(err)
	}
	mt := mime.TypeByExtension(strings.ToLower(path.Ext(normalized)))
	if mt == "" {
		mt = http.DetectContentType(c.Data)
	}
	return BinaryContent{Path: normalized, Mime: mt, Data: base64.StdEncoding.EncodeToString(c.Data), Size: c.Size}, nil
}

// SaveAttachment stores pasted or dropped data (base64) as dir/name, adding a
// numeric suffix instead of overwriting, and returns the final vault path.
func (v *VaultAPI) SaveAttachment(vaultID, dir, name, dataBase64 string) (string, error) {
	if err := v.app.writable(vaultID); err != nil {
		return "", err
	}
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return "", fmt.Errorf("invalid: %w", err)
	}
	if len(data) > MaxBinaryBytes {
		return "", fmt.Errorf("too-large: attachment is %d bytes (limit %d)", len(data), MaxBinaryBytes)
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	ext := path.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s %d%s", stem, i, ext)
		}
		p := candidate
		if dir != "" {
			p = strings.Trim(dir, "/") + "/" + candidate
		}
		c, err := ov.FS.WriteFile(p, data, "", true)
		if errors.Is(err, vault.ErrExists) {
			continue
		}
		if err != nil {
			return "", bindingError(err)
		}
		_ = ov.Indexer.Update(context.Background(), []string{c.Path})
		return c.Path, nil
	}
	return "", errors.New("exists: too many files with that name")
}

// TagCount is a tag with the number of notes using it.
type TagCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// TagsAPI exposes the vault tag index.
type TagsAPI struct{ app *App }

// NewTagsAPI binds the API.
func NewTagsAPI(a *App) *TagsAPI { return &TagsAPI{app: a} }

// List returns every tag with its note count (flat; the UI builds the a/b/c hierarchy).
func (t *TagsAPI) List(vaultID string) ([]TagCount, error) {
	ov, err := t.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	rows, err := ov.Indexer.DB().QueryContext(context.Background(),
		`SELECT name, count(DISTINCT path) FROM tags GROUP BY name ORDER BY lower(name)`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []TagCount{}
	for rows.Next() {
		var c TagCount
		if err := rows.Scan(&c.Name, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// PropertiesAPI exposes typed properties (§2.2.1 "Properties").
type PropertiesAPI struct{ app *App }

// NewPropertiesAPI binds the API.
func NewPropertiesAPI(a *App) *PropertiesAPI { return &PropertiesAPI{app: a} }

// PropertyKey is a property name used in the vault.
type PropertyKey struct {
	Key   string `json:"key"`
	Kind  string `json:"kind"`  // declared type, else the most common inferred one
	Count int    `json:"count"` // notes using it
}

func (p *PropertiesAPI) schema(ov *openVault) properties.Schema {
	c, err := ov.FS.ReadFile(pathrules.ConfigDir + "/types.json")
	if err != nil {
		return properties.Schema{}
	}
	s, err := properties.ParseSchema(c.Data)
	if err != nil {
		return properties.Schema{}
	}
	return s
}

// Keys lists the property names of the vault with their effective type.
func (p *PropertiesAPI) Keys(vaultID string) ([]PropertyKey, error) {
	ov, err := p.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	rows, err := ov.Indexer.DB().QueryContext(context.Background(), `
		SELECT key, kind, count(*) AS n FROM properties GROUP BY lower(key), kind ORDER BY lower(key), n DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	schema := p.schema(ov)
	seen := map[string]int{}
	out := []PropertyKey{}
	for rows.Next() {
		var k PropertyKey
		if err := rows.Scan(&k.Key, &k.Kind, &k.Count); err != nil {
			return nil, err
		}
		if i, ok := seen[strings.ToLower(k.Key)]; ok {
			out[i].Count += k.Count // same key with a less common inferred type
			continue
		}
		if declared := schema.KindFor(k.Key, nil); declared != properties.Text || schema[k.Key] != "" {
			if _, isDeclared := schema[k.Key]; isDeclared {
				k.Kind = string(declared)
			}
		}
		seen[strings.ToLower(k.Key)] = len(out)
		out = append(out, k)
	}
	return out, rows.Err()
}

// Schema returns the declared types (.nodus/types.json).
func (p *PropertiesAPI) Schema(vaultID string) (map[string]string, error) {
	ov, err := p.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for k, v := range p.schema(ov) {
		out[k] = string(v)
	}
	return out, nil
}

// SetType declares the type of a property for the whole vault; an empty kind removes the declaration.
func (p *PropertiesAPI) SetType(vaultID, key, kind string) error {
	if err := p.app.writable(vaultID); err != nil {
		return err
	}
	ov, err := p.app.vault(vaultID)
	if err != nil {
		return err
	}
	if key == "" {
		return errors.New("invalid: property name is empty")
	}
	schema := p.schema(ov)
	if kind == "" {
		delete(schema, key)
	} else {
		k := properties.Kind(kind)
		if !k.Valid() {
			return fmt.Errorf("invalid: unknown property type %q", kind)
		}
		schema[key] = k
	}
	data, err := schema.Marshal()
	if err != nil {
		return err
	}
	_, err = ov.FS.WriteFile(pathrules.ConfigDir+"/types.json", data, "", false)
	return bindingError(err)
}

// Update sets a property of a note. valueJSON is the JSON-encoded value; it is
// coerced to the declared (or inferred) type of the property. expectedHash
// guards against concurrent edits like WriteNote.
func (p *PropertiesAPI) Update(vaultID, notePath, key, valueJSON, expectedHash string) (WriteResult, error) {
	if err := p.app.writable(vaultID); err != nil {
		return WriteResult{}, err
	}
	ov, err := p.app.vault(vaultID)
	if err != nil {
		return WriteResult{}, err
	}
	var raw any
	if err := json.Unmarshal([]byte(valueJSON), &raw); err != nil {
		return WriteResult{}, fmt.Errorf("invalid: value is not JSON: %w", err)
	}
	cur, err := ov.FS.ReadFile(notePath)
	if err != nil {
		return WriteResult{}, bindingError(err)
	}
	if expectedHash != "" && cur.Hash != expectedHash {
		return WriteResult{}, bindingError(vault.ErrHashMismatch)
	}
	kind := p.schema(ov).KindFor(key, raw)
	value, err := properties.Coerce(kind, raw)
	if err != nil {
		return WriteResult{}, fmt.Errorf("invalid: %w", err)
	}
	out, err := properties.Set(cur.Data, key, value)
	if err != nil {
		return WriteResult{}, fmt.Errorf("invalid: %w", err)
	}
	c, err := ov.FS.WriteFile(notePath, out, cur.Hash, false)
	if err != nil {
		return WriteResult{}, bindingError(err)
	}
	_ = ov.Indexer.Update(context.Background(), []string{c.Path})
	return WriteResult{Path: c.Path, Hash: c.Hash, Size: c.Size}, nil
}

// Remove deletes a property from a note.
func (p *PropertiesAPI) Remove(vaultID, notePath, key, expectedHash string) (WriteResult, error) {
	if err := p.app.writable(vaultID); err != nil {
		return WriteResult{}, err
	}
	ov, err := p.app.vault(vaultID)
	if err != nil {
		return WriteResult{}, err
	}
	cur, err := ov.FS.ReadFile(notePath)
	if err != nil {
		return WriteResult{}, bindingError(err)
	}
	if expectedHash != "" && cur.Hash != expectedHash {
		return WriteResult{}, bindingError(vault.ErrHashMismatch)
	}
	out, err := properties.Delete(cur.Data, key)
	if err != nil {
		return WriteResult{}, fmt.Errorf("invalid: %w", err)
	}
	c, err := ov.FS.WriteFile(notePath, out, cur.Hash, false)
	if err != nil {
		return WriteResult{}, bindingError(err)
	}
	_ = ov.Indexer.Update(context.Background(), []string{c.Path})
	return WriteResult{Path: c.Path, Hash: c.Hash, Size: c.Size}, nil
}
