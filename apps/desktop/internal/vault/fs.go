// Package vault implements the file-system side of a vault: safe path
// resolution, atomic writes, rename, trash and tree listing (§2.5 "vault").
// Every path handed to this package is vault-relative and goes through
// pathrules; the resolved absolute path must stay inside the vault root even
// in the presence of symlinks.
package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"memobrain/shared/hashing"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// Errors returned by FS operations.
var (
	ErrOutsideVault = errors.New("path escapes the vault")
	ErrExists       = errors.New("already exists")
	ErrNotFound     = os.ErrNotExist
	ErrHashMismatch = errors.New("file changed on disk since it was read")
	ErrIsDirectory  = errors.New("is a directory")
)

// FS is a vault root on disk.
type FS struct {
	root     string // absolute, symlinks resolved
	onChange atomic.Pointer[func(paths []string)]
}

// SetOnChange registers a callback told, after every successful mutation made through this FS,
// which vault-relative paths changed. The desktop does not use it (fsnotify reports changes,
// including those made by other programs); the browser build has no file watcher, so there it is
// the only source of change events.
func (f *FS) SetOnChange(fn func(paths []string)) {
	if fn == nil {
		f.onChange.Store(nil)
		return
	}
	f.onChange.Store(&fn)
}

func (f *FS) changed(paths ...string) {
	if fn := f.onChange.Load(); fn != nil {
		(*fn)(paths)
	}
}

// NewFS validates that root exists and is a directory.
func NewFS(root string) (*FS, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("%s: not a directory", root)
	}
	return &FS{root: resolved}, nil
}

// Root is the absolute vault directory.
func (f *FS) Root() string { return f.root }

// Resolve turns a vault-relative path into an absolute one, rejecting
// invalid paths and anything that resolves outside the root. The returned
// normalized relative path is NFC with '/' separators.
func (f *FS) Resolve(rel string) (abs, normalized string, err error) {
	normalized, err = pathrules.Normalize(rel)
	if err != nil {
		return "", "", err
	}
	abs = filepath.Join(f.root, filepath.FromSlash(normalized))
	// Walk up to the deepest existing ancestor and make sure that, with
	// symlinks resolved, it is still inside the root.
	probe := abs
	for {
		resolved, err := filepath.EvalSymlinks(probe)
		if err == nil {
			if !f.inside(resolved) {
				return "", "", ErrOutsideVault
			}
			break
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", "", err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", "", ErrOutsideVault
		}
		probe = parent
	}
	return abs, normalized, nil
}

func (f *FS) inside(abs string) bool {
	rel, err := filepath.Rel(f.root, abs)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

// Content is a file read together with its content hash, used by WriteFile
// to detect concurrent external modifications (expectedHash).
type Content struct {
	Path  string
	Data  []byte
	Hash  string
	Mtime time.Time
	Size  int64
}

// ReadFile reads a vault file.
func (f *FS) ReadFile(rel string) (Content, error) {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return Content{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return Content{}, err
	}
	if st.IsDir() {
		return Content{}, ErrIsDirectory
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return Content{}, err
	}
	return Content{Path: normalized, Data: data, Hash: hashing.Sum(data).Hex(), Mtime: st.ModTime(), Size: st.Size()}, nil
}

// WriteFile writes data atomically (temporary file in the same directory,
// fsync, rename). When expectedHash is not empty the current content must
// hash to it, otherwise ErrHashMismatch is returned and nothing is written;
// an empty expectedHash with an existing file means "overwrite". Pass
// create=true to require that the file does not exist yet (ErrExists).
func (f *FS) WriteFile(rel string, data []byte, expectedHash string, create bool) (Content, error) {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return Content{}, err
	}
	if st, err := os.Stat(abs); err == nil {
		if st.IsDir() {
			return Content{}, ErrIsDirectory
		}
		if create {
			return Content{}, ErrExists
		}
		if expectedHash != "" {
			cur, err := os.ReadFile(abs)
			if err != nil {
				return Content{}, err
			}
			if hashing.Sum(cur).Hex() != expectedHash {
				return Content{}, ErrHashMismatch
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Content{}, err
	} else if expectedHash != "" && !create {
		// Caller expected an existing file: it was deleted meanwhile.
		return Content{}, ErrHashMismatch
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return Content{}, err
	}
	if err := writeAtomic(abs, data); err != nil {
		return Content{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return Content{}, err
	}
	f.changed(normalized)
	return Content{Path: normalized, Data: data, Hash: hashing.Sum(data).Hex(), Mtime: st.ModTime(), Size: st.Size()}, nil
}

// Steps of writeAtomic reported to crashHook (fault injection in tests).
const (
	stepTmpWritten = "tmp-written"   // temporary file holds the data, not yet fsynced
	stepSynced     = "synced"        // data fsynced and closed
	stepBeforeRen  = "before-rename" // mode set, rename not yet issued
	stepRenamed    = "renamed"       // target replaced, directory not yet fsynced
)

// crashHook, when set (tests only), is called after each step of writeAtomic.
// A hook that panics or exits simulates a crash at that point: the deferred
// error cleanup does not run, exactly as after a power loss.
var crashHook func(step string)

func crashPoint(step string) {
	if crashHook != nil {
		crashHook(step)
	}
}

func writeAtomic(abs string, data []byte) error {
	dir := filepath.Dir(abs)
	tmp, err := os.CreateTemp(dir, tmpPrefix+"*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	crashPoint(stepTmpWritten)
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	crashPoint(stepSynced)
	if err := os.Chmod(tmpName, 0o644); err != nil {
		cleanup()
		return err
	}
	crashPoint(stepBeforeRen)
	if err := os.Rename(tmpName, abs); err != nil {
		cleanup()
		return err
	}
	crashPoint(stepRenamed)
	return syncDir(dir)
}

// tmpPrefix names the staging files of atomic writes.
const tmpPrefix = ".memobrain-tmp-"

// CleanStaleTemp removes staging files left by a crashed write. Only files
// older than olderThan are removed, so a write in progress is never touched.
// It returns the number of files removed.
func (f *FS) CleanStaleTemp(olderThan time.Duration) (int, error) {
	n := 0
	cutoff := time.Now().Add(-olderThan)
	err := filepath.WalkDir(f.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // best effort: unreadable folders are skipped
		}
		if d.IsDir() || !strings.HasPrefix(d.Name(), tmpPrefix) {
			return nil
		}
		if info, ierr := d.Info(); ierr == nil && info.ModTime().Before(cutoff) {
			if os.Remove(p) == nil {
				n++
			}
		}
		return nil
	})
	return n, err
}

// syncDir flushes the directory entry; best effort on platforms where
// directories cannot be fsynced.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return nil //nolint:nilerr // best effort
	}
	defer func() { _ = d.Close() }()
	_ = d.Sync()
	return nil
}

// Mkdir creates a folder (and parents).
func (f *FS) Mkdir(rel string) error {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return err
	}
	f.changed(normalized)
	return nil
}

// Rename moves a file or folder; the destination must not exist.
func (f *FS) Rename(fromRel, toRel string) error {
	from, fromNorm, err := f.Resolve(fromRel)
	if err != nil {
		return err
	}
	to, toNorm, err := f.Resolve(toRel)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(from); err != nil {
		return err
	}
	if _, err := os.Lstat(to); err == nil {
		if !strings.EqualFold(from, to) { // allow case-only renames on case-insensitive file systems
			return ErrExists
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	if err := os.Rename(from, to); err != nil {
		return err
	}
	f.changed(fromNorm, toNorm)
	return nil
}

// Trash moves a file or folder into the vault's .trash/ folder, keeping the
// relative layout and avoiding collisions with a timestamp suffix. It returns
// the trash-relative destination.
func (f *FS) Trash(rel string) (string, error) {
	from, normalized, err := f.Resolve(rel)
	if err != nil {
		return "", err
	}
	if pathrules.HasPrefix(normalized, pathrules.TrashDir) {
		return "", fmt.Errorf("%s is already in the trash", normalized)
	}
	dest := pathrules.TrashDir + "/" + normalized
	to, _, err := f.Resolve(dest)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(to); err == nil {
		dir, base := pathrules.Split(dest)
		ext := pathrules.Ext(base)
		stem := strings.TrimSuffix(base, ext)
		dest = dir + "/" + stem + " " + time.Now().Format("2006-01-02 15-04-05") + ext
		if to, _, err = f.Resolve(dest); err != nil {
			return "", err
		}
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(from, to); err != nil {
		return "", err
	}
	f.changed(normalized, dest)
	return dest, nil
}

// Delete removes a file or folder permanently.
func (f *FS) Delete(rel string) error {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(abs); err != nil {
		return err
	}
	f.changed(normalized)
	return nil
}

// Entry describes one file or folder in the vault tree.
type Entry struct {
	Path  string             `json:"path"`
	Name  string             `json:"name"`
	IsDir bool               `json:"isDir"`
	Kind  syncproto.FileKind `json:"kind"`
	Size  int64              `json:"size"`
	Mtime time.Time          `json:"mtime"`
}

// Walk visits every file and folder of the vault (depth first, sorted),
// skipping excluded entries (.DS_Store, caches, …), symlinks and the
// .memobrain/ internals other than user settings. fn receives vault-relative
// paths. Returning fs.SkipDir from fn for a folder skips its contents.
func (f *FS) Walk(fn func(e Entry) error) error {
	return f.walk(f.root, "", fn)
}

func (f *FS) walk(absDir, relDir string, fn func(e Entry) error) error {
	entries, err := os.ReadDir(absDir)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, de := range entries {
		name := de.Name()
		rel := name
		if relDir != "" {
			rel = relDir + "/" + name
		}
		normalized, err := pathrules.Normalize(rel)
		if err != nil {
			continue // names we cannot represent are invisible to the app
		}
		if de.Type()&fs.ModeSymlink != 0 {
			continue
		}
		if pathrules.IsExcluded(normalized, false) {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		e := Entry{Path: normalized, Name: name, IsDir: de.IsDir(), Mtime: info.ModTime()}
		if !e.IsDir {
			e.Kind = syncproto.KindOf(normalized)
			e.Size = info.Size()
		}
		err = fn(e)
		if err == nil && e.IsDir {
			err = f.walk(filepath.Join(absDir, name), normalized, fn)
		}
		if errors.Is(err, fs.SkipDir) {
			continue
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// ListTree returns the whole tree as a flat sorted list.
func (f *FS) ListTree() ([]Entry, error) {
	var out []Entry
	err := f.Walk(func(e Entry) error {
		out = append(out, e)
		return nil
	})
	return out, err
}

// HashFile streams a file through SHA-256 without loading it in memory.
func (f *FS) HashFile(rel string) (string, int64, error) {
	abs, _, err := f.Resolve(rel)
	if err != nil {
		return "", 0, err
	}
	fh, err := os.Open(abs)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = fh.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, fh)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
