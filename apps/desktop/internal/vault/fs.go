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
	"hash/fnv"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"clarae/shared/hashing"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

// Errors returned by FS operations.
var (
	ErrOutsideVault = errors.New("path escapes the vault")
	ErrExists       = errors.New("already exists")
	ErrNotFound     = os.ErrNotExist
	ErrHashMismatch = errors.New("file changed on disk since it was read")
	ErrIsDirectory  = errors.New("is a directory")
)

// FS is a vault root on disk. It is safe for concurrent use: the Wails
// bindings, the importer and the sync engine share one FS per vault, so every
// mutation takes the locks described at lockPath and lockTree.
type FS struct {
	root     string // absolute, symlinks resolved
	onChange atomic.Pointer[func(paths []string)]

	// tree is held shared by content mutations (WriteFile, Mkdir) and
	// exclusively by structural ones (Rename, Trash, Delete), which may move
	// or remove a whole folder and therefore every path below it.
	tree sync.RWMutex
	// stripes serialize content mutations of the same path. A path maps to
	// a stripe by its case-folded NFC key, so names that collide on a
	// case-insensitive file system (A.md, a.md) share a stripe.
	stripes [lockStripes]sync.Mutex
}

// lockStripes is the number of per-path mutexes; unrelated paths sharing a
// stripe only wait for each other, which is harmless.
const lockStripes = 64

// lockPath makes the existence/hash check and the publication of a write to
// normalized one atomic step with respect to every other mutation made
// through this FS. It returns the unlock function. Never nest it, nor call it
// while holding lockTree.
func (f *FS) lockPath(normalized string) (unlock func()) {
	h := fnv.New32a()
	_, _ = h.Write([]byte(pathrules.Key(normalized)))
	m := &f.stripes[h.Sum32()%lockStripes]
	f.tree.RLock()
	m.Lock()
	return func() {
		m.Unlock()
		f.tree.RUnlock()
	}
}

// lockTree excludes every other mutation made through this FS, for the
// operations that move or remove folders (whose descendants a per-path lock
// would not cover). Holding it, no per-path lock is needed, so there is no
// lock ordering to get wrong.
func (f *FS) lockTree() (unlock func()) {
	f.tree.Lock()
	return f.tree.Unlock
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

// inside reports whether abs (symlinks already resolved) is the root or below
// it. Only a ".." segment leaves the root: "..Archive/n.md" is a folder of
// the vault whose name starts with two dots.
func (f *FS) inside(abs string) bool {
	rel, err := filepath.Rel(f.root, abs)
	if err != nil {
		return false // e.g. another volume on Windows
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(rel) && filepath.VolumeName(rel) == ""
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
//
// The check and the replacement are atomic with respect to the other
// mutations made through this FS: of two concurrent writes with the same
// expectedHash exactly one succeeds. With create=true the file is published
// with a hard link where the file system supports it, which also refuses a
// file another program created meanwhile instead of replacing it.
func (f *FS) WriteFile(rel string, data []byte, expectedHash string, create bool) (Content, error) {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return Content{}, err
	}
	c, err := f.writeFile(abs, normalized, data, expectedHash, create)
	if err != nil {
		return Content{}, err
	}
	f.changed(normalized) // outside the lock: the callback may call back into the FS
	return c, nil
}

func (f *FS) writeFile(abs, normalized string, data []byte, expectedHash string, create bool) (Content, error) {
	unlock := f.lockPath(normalized)
	defer unlock()
	perm := fs.FileMode(0o644)
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
		perm = st.Mode().Perm() // keep the permissions the user gave the file
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Content{}, err
	} else if expectedHash != "" && !create {
		// Caller expected an existing file: it was deleted meanwhile.
		return Content{}, ErrHashMismatch
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return Content{}, err
	}
	if err := writeAtomic(abs, data, perm, create); err != nil {
		return Content{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return Content{}, err
	}
	return Content{Path: normalized, Data: data, Hash: hashing.Sum(data).Hex(), Mtime: st.ModTime(), Size: st.Size()}, nil
}

// WriteFileFrom creates rel with the content read from r, streamed to the
// staging file so that a large file (an imported attachment) never sits in
// memory. Like WriteFile with create=true it never replaces a file: ErrExists
// when rel exists. It returns the hash and the size of what was written.
//
// The copy runs without the path lock, which can take long; the existence
// check and the publication are atomic with respect to the other mutations
// made through this FS, as in WriteFile.
func (f *FS) WriteFileFrom(rel string, r io.Reader) (hash string, size int64, err error) {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return "", 0, err
	}
	if st, err := os.Lstat(abs); err == nil {
		if st.IsDir() {
			return "", 0, ErrIsDirectory
		}
		return "", 0, ErrExists // fail before copying anything
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", 0, err
	}
	h := sha256.New()
	tmpName, err := stageTemp(filepath.Dir(abs), 0o644, func(w io.Writer) error {
		var cerr error
		size, cerr = io.Copy(io.MultiWriter(w, h), r)
		return cerr
	})
	if err != nil {
		return "", 0, err
	}
	err = func() error {
		unlock := f.lockPath(normalized)
		defer unlock()
		if st, err := os.Lstat(abs); err == nil {
			_ = os.Remove(tmpName)
			if st.IsDir() {
				return ErrIsDirectory
			}
			return ErrExists
		} else if !errors.Is(err, fs.ErrNotExist) {
			_ = os.Remove(tmpName)
			return err
		}
		return publishTemp(tmpName, abs, true)
	}()
	if err != nil {
		return "", 0, err
	}
	f.changed(normalized) // outside the lock: the callback may call back into the FS
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

// Steps of writeAtomic reported to crashHook (fault injection in tests).
const (
	stepTmpWritten = "tmp-written"   // temporary file holds the data, not yet fsynced
	stepSynced     = "synced"        // data fsynced and closed
	stepBeforeRen  = "before-rename" // mode set, rename (or link) not yet issued
	stepRenamed    = "renamed"       // target published, directory not yet fsynced
)

// linkFile publishes a staging file without replacing an existing target; a
// variable so tests can simulate file systems without hard links.
var linkFile = os.Link

// crashHook, when set (tests only), is called after each step of writeAtomic.
// A hook that panics or exits simulates a crash at that point: the deferred
// error cleanup does not run, exactly as after a power loss.
var crashHook func(step string)

func crashPoint(step string) {
	if crashHook != nil {
		crashHook(step)
	}
}

// writeAtomic stages data in a temporary file next to abs, fsyncs it and
// publishes it as abs with mode perm. With noReplace an existing abs is never
// replaced (ErrExists): the staging file is hard-linked to abs, which fails
// atomically when abs exists. Where hard links are not available (the OPFS
// file system of the browser build, FAT, some network shares) it falls back
// to rename, relying on the caller's lockPath to have checked that abs does
// not exist.
func writeAtomic(abs string, data []byte, perm fs.FileMode, noReplace bool) error {
	tmpName, err := stageTemp(filepath.Dir(abs), perm, func(w io.Writer) error {
		_, err := w.Write(data)
		return err
	})
	if err != nil {
		return err
	}
	return publishTemp(tmpName, abs, noReplace)
}

// stageTemp creates a staging file in dir, fills it with fill, fsyncs it and
// gives it mode perm. It returns the staging file name; on error nothing is left.
func stageTemp(dir string, perm fs.FileMode, fill func(w io.Writer) error) (string, error) {
	tmp, err := os.CreateTemp(dir, pathrules.TmpPrefix+"*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if err := fill(tmp); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", err
	}
	crashPoint(stepTmpWritten)
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", err
	}
	crashPoint(stepSynced)
	if err := os.Chmod(tmpName, perm); err != nil {
		cleanup()
		return "", err
	}
	crashPoint(stepBeforeRen)
	return tmpName, nil
}

// publishTemp publishes the staging file tmpName as abs (see writeAtomic for
// noReplace). The staging file is gone afterwards, whatever the outcome.
func publishTemp(tmpName, abs string, noReplace bool) error {
	dir := filepath.Dir(abs)
	cleanup := func() { _ = os.Remove(tmpName) }
	if noReplace {
		err := linkFile(tmpName, abs)
		switch {
		case err == nil:
			// abs now names the staging inode; a leftover staging name
			// (crash right here) is removed by CleanStaleTemp.
			cleanup()
			crashPoint(stepRenamed)
			return syncDir(dir)
		case errors.Is(err, fs.ErrExist):
			cleanup()
			return ErrExists
		}
		// No hard links on this file system: publish with rename below.
	}
	if err := os.Rename(tmpName, abs); err != nil {
		cleanup()
		return err
	}
	crashPoint(stepRenamed)
	return syncDir(dir)
}

// CleanStaleTemp removes staging files left by a crashed write, under the current and the 1.4.0
// prefix (pathrules.IsTmpName). Only files
// older than olderThan are removed, so a write in progress is never touched.
// It returns the number of files removed.
func (f *FS) CleanStaleTemp(olderThan time.Duration) (int, error) {
	n := 0
	cutoff := time.Now().Add(-olderThan)
	err := filepath.WalkDir(f.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // best effort: unreadable folders are skipped
		}
		if d.IsDir() || !pathrules.IsTmpName(d.Name()) {
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

// syncDir flushes the directory entry so that a rename survives a power
// loss. It is best effort where directories cannot be fsynced (Windows, the
// browser build, file systems that report the operation as unsupported); any
// other failure is returned, since the write may not be durable.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" || runtime.GOOS == "js" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return nil //nolint:nilerr // best effort: the data itself was fsynced
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil && !dirSyncUnsupported(err) {
		return fmt.Errorf("fsync %s: %w", dir, err)
	}
	return nil
}

func dirSyncUnsupported(err error) bool {
	return errors.Is(err, errors.ErrUnsupported) || errors.Is(err, syscall.EINVAL) ||
		errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EOPNOTSUPP)
}

// Mkdir creates a folder (and parents).
func (f *FS) Mkdir(rel string) error {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return err
	}
	unlock := f.lockPath(normalized)
	err = os.MkdirAll(abs, 0o755)
	unlock()
	if err != nil {
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
	if err := f.rename(from, to); err != nil {
		return err
	}
	f.changed(fromNorm, toNorm)
	return nil
}

func (f *FS) rename(from, to string) error {
	unlock := f.lockTree()
	defer unlock()
	fromInfo, err := os.Lstat(from)
	if err != nil {
		return err
	}
	if toInfo, err := os.Lstat(to); err == nil {
		// A case-only rename on a case-insensitive file system finds the
		// source itself under the new name; on a case-sensitive one the
		// other name may be a different file, which os.Rename would replace.
		if !strings.EqualFold(from, to) || !sameEntry(fromInfo, toInfo, to) {
			return ErrExists
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	return os.Rename(from, to)
}

// sameEntry reports whether to, which differs from the source only in case,
// names the source itself rather than another file. The folder listing is
// the portable test: a case-insensitive file system lists the entry under its
// actual name only, while a distinct file shows up with to's exact name. The
// browser's file system has no inode numbers, so os.SameFile is an extra
// check only on the others.
func sameEntry(fromInfo, toInfo fs.FileInfo, to string) bool {
	if runtime.GOOS != "js" && !os.SameFile(fromInfo, toInfo) {
		return false
	}
	base := filepath.Base(to)
	if fromInfo.Name() == base {
		return true // the very same name: nothing to rename
	}
	entries, err := os.ReadDir(filepath.Dir(to))
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Name() == base {
			return false
		}
	}
	return true
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
	dest, err := f.trash(from, normalized)
	if err != nil {
		return "", err
	}
	f.changed(normalized, dest)
	return dest, nil
}

func (f *FS) trash(from, normalized string) (string, error) {
	unlock := f.lockTree()
	defer unlock()
	dest := pathrules.TrashDir + "/" + normalized
	to, _, err := f.Resolve(dest)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(to); err == nil {
		dir, base := pathrules.Split(dest)
		ext := pathrules.Ext(base)
		stem := strings.TrimSuffix(base, ext) + " " + time.Now().Format("2006-01-02 15-04-05")
		// os.Rename replaces an existing file: a name trashed twice within
		// the same second gets a counter too.
		for n := 1; ; n++ {
			dest = dir + "/" + stem + ext
			if n > 1 {
				dest = fmt.Sprintf("%s/%s (%d)%s", dir, stem, n, ext)
			}
			if to, _, err = f.Resolve(dest); err != nil {
				return "", err
			}
			if _, err := os.Lstat(to); errors.Is(err, fs.ErrNotExist) {
				break
			} else if err != nil {
				return "", err
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(from, to); err != nil {
		return "", err
	}
	return dest, nil
}

// Delete removes a file or folder permanently.
func (f *FS) Delete(rel string) error {
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return err
	}
	unlock := f.lockTree()
	err = os.RemoveAll(abs)
	unlock()
	if err != nil {
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
// .clarae/ internals other than user settings. fn receives vault-relative
// paths. Returning fs.SkipDir from fn for a folder skips its contents.
func (f *FS) Walk(fn func(e Entry) error) error {
	return f.walk(f.root, "", fn)
}

// WalkDir is Walk restricted to what lies below the folder rel (rel itself is
// not visited); "" walks the whole vault. An excluded folder yields nothing.
func (f *FS) WalkDir(rel string, fn func(e Entry) error) error {
	if rel == "" {
		return f.Walk(fn)
	}
	abs, normalized, err := f.Resolve(rel)
	if err != nil {
		return err
	}
	if pathrules.IsExcluded(normalized, false) {
		return nil
	}
	if st, err := os.Lstat(abs); err != nil {
		return err
	} else if st.Mode()&fs.ModeSymlink != 0 || !st.IsDir() {
		return nil // Walk does not follow symlinks either
	}
	return f.walk(abs, normalized, fn)
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
