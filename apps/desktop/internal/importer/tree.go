package importer

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
)

// Limits bound what an untrusted source may make the importer read.
type Limits struct {
	// MaxEntries caps the number of files in an archive or folder.
	MaxEntries int
	// MaxTotalBytes caps the uncompressed size of everything read from a source.
	MaxTotalBytes int64
	// MaxEntryBytes caps one file (also the size of a single-file source such as ENEX).
	MaxEntryBytes int64
	// MaxReadBytes caps a file read whole into memory to be converted (a note, its metadata, a
	// CSV). Attachments are streamed to the vault and only bound by MaxEntryBytes. Zero (or a
	// value above MaxEntryBytes) means MaxEntryBytes.
	MaxReadBytes int64
}

// DefaultLimits are generous for real exports and stop zip bombs.
var DefaultLimits = Limits{MaxEntries: 200_000, MaxTotalBytes: 8 << 30, MaxEntryBytes: 1 << 30, MaxReadBytes: 64 << 20}

// readBytes is the effective MaxReadBytes.
func (l Limits) readBytes() int64 {
	if l.MaxReadBytes > 0 && l.MaxReadBytes < l.MaxEntryBytes {
		return l.MaxReadBytes
	}
	return l.MaxEntryBytes
}

// Errors for sources that exceed the limits.
var (
	ErrTooManyEntries = errors.New("too-large: the source contains too many files")
	ErrTooLarge       = errors.New("too-large: the source is larger than the import limit")
	// ErrTooLargeToConvert is a note or metadata file above Limits.MaxReadBytes.
	ErrTooLargeToConvert = errors.New("too-large: the file is too large to be converted")
)

// File is one regular file of a source tree.
type File struct {
	Path string // validated, '/'-separated, relative
	Size int64  // declared size
}

// Tree is a read-only view of a folder or archive. Names in a tree are validated: absolute
// paths, "..", backslashes and NUL never reach the importers.
type Tree interface {
	Files() []File
	// Open returns a reader capped by the limits (the declared size is not trusted).
	Open(name string) (io.ReadCloser, error)
	// Rejected lists entries that were refused, with the reason.
	Rejected() []string
	Close() error
}

// validEntryName reports whether an archive entry name is safe to treat as a relative path.
func validEntryName(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "/") {
		return false
	}
	if len(name) >= 2 && name[1] == ':' { // C:foo
		return false
	}
	for _, seg := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		if seg == ".." || seg == "" {
			return false
		}
	}
	return true
}

// entryPath validates an archive entry name and returns it as a clean relative path. Zip tools
// may write "." segments ("./Notes/a.md", "Notes/./a.md"): they are dropped, so the name the
// importers see, the name Open looks up and the duplicate check are one and the same.
func entryPath(name string) (string, bool) {
	if !validEntryName(name) {
		return "", false
	}
	clean := path.Clean(name)
	if clean == "." {
		return "", false
	}
	return clean, true
}

func skipEntry(name string) bool {
	for _, seg := range strings.Split(name, "/") {
		if seg == "__MACOSX" || seg == ".DS_Store" || seg == "Thumbs.db" || seg == "desktop.ini" {
			return true
		}
	}
	return false
}

// budget tracks the bytes actually read across a whole source.
type budget struct {
	used  atomic.Int64
	max   int64
	entry int64
	read  int64 // cap of a file read whole into memory (readAll)
}

func newBudget(lim Limits) *budget {
	return &budget{max: lim.MaxTotalBytes, entry: lim.MaxEntryBytes, read: lim.readBytes()}
}

type capReader struct {
	r    io.Reader
	c    io.Closer
	b    *budget
	read int64
}

func (c *capReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read += int64(n)
	if c.read > c.b.entry || c.b.used.Add(int64(n)) > c.b.max {
		return 0, ErrTooLarge
	}
	return n, err
}

func (c *capReader) Close() error { return c.c.Close() }

// OpenTree opens a directory or a .zip file as a Tree.
func OpenTree(p string, lim Limits) (Tree, error) {
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return openDirTree(p, lim)
	}
	return openZipTree(p, lim)
}

// ---- directory ----

type dirTree struct {
	root     string
	files    []File
	rejected []string
	b        *budget
}

func openDirTree(root string, lim Limits) (*dirTree, error) {
	t := &dirTree{root: root, b: newBudget(lim)}
	var total int64
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped
		}
		if p == root {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.Type()&fs.ModeSymlink != 0 {
			t.rejected = append(t.rejected, rel+": symbolic link")
			return nil
		}
		if d.IsDir() {
			if skipEntry(rel) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || skipEntry(rel) || !validEntryName(rel) {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if len(t.files) >= lim.MaxEntries {
			return ErrTooManyEntries
		}
		if info.Size() > lim.MaxEntryBytes {
			t.rejected = append(t.rejected, rel+": file too large")
			return nil
		}
		total += info.Size()
		if total > lim.MaxTotalBytes {
			return ErrTooLarge
		}
		t.files = append(t.files, File{Path: rel, Size: info.Size()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(t.files, func(i, j int) bool { return t.files[i].Path < t.files[j].Path })
	return t, nil
}

func (t *dirTree) Files() []File      { return t.files }
func (t *dirTree) Rejected() []string { return t.rejected }
func (t *dirTree) Close() error       { return nil }

func (t *dirTree) Open(name string) (io.ReadCloser, error) {
	if !validEntryName(name) {
		return nil, fmt.Errorf("invalid entry name %q", name)
	}
	abs := filepath.Join(t.root, filepath.FromSlash(name))
	if st, err := os.Lstat(abs); err != nil || !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s: not a regular file", name)
	}
	f, err := os.Open(abs)
	if err != nil {
		return nil, err
	}
	return &capReader{r: f, c: f, b: t.b}, nil
}

// ---- zip ----

type zipTree struct {
	zr       *zip.ReadCloser
	byName   map[string]*zip.File
	files    []File
	rejected []string
	b        *budget
}

func openZipTree(p string, lim Limits) (*zipTree, error) {
	zr, err := zip.OpenReader(p)
	if errors.Is(err, zip.ErrInsecurePath) && zr != nil {
		err = nil // unsafe names are rejected one by one below
	}
	if err != nil {
		return nil, fmt.Errorf("invalid: not a readable zip archive: %w", err)
	}
	t := &zipTree{zr: zr, byName: map[string]*zip.File{}, b: newBudget(lim)}
	if len(zr.File) > lim.MaxEntries {
		_ = zr.Close()
		return nil, ErrTooManyEntries
	}
	var total uint64
	for _, f := range zr.File {
		name := f.Name
		if strings.HasSuffix(name, "/") || f.FileInfo().IsDir() {
			if !validEntryName(name) {
				t.rejected = append(t.rejected, name+": unsafe path")
			}
			continue
		}
		clean, ok := entryPath(name)
		if !ok {
			t.rejected = append(t.rejected, name+": unsafe path")
			continue
		}
		if f.Mode()&fs.ModeSymlink != 0 {
			t.rejected = append(t.rejected, name+": symbolic link")
			continue
		}
		if skipEntry(clean) {
			continue
		}
		if f.UncompressedSize64 > math.MaxInt64 || int64(f.UncompressedSize64) > lim.MaxEntryBytes {
			t.rejected = append(t.rejected, name+": file too large")
			continue
		}
		total += f.UncompressedSize64
		if total > uint64(lim.MaxTotalBytes) { //nolint:gosec // limits are positive
			_ = zr.Close()
			return nil, ErrTooLarge
		}
		if _, dup := t.byName[clean]; dup {
			t.rejected = append(t.rejected, name+": duplicate entry")
			continue
		}
		t.byName[clean] = f
		t.files = append(t.files, File{Path: clean, Size: int64(f.UncompressedSize64)})
	}
	sort.Slice(t.files, func(i, j int) bool { return t.files[i].Path < t.files[j].Path })
	return t, nil
}

func (t *zipTree) Files() []File      { return t.files }
func (t *zipTree) Rejected() []string { return t.rejected }
func (t *zipTree) Close() error       { return t.zr.Close() }

func (t *zipTree) Open(name string) (io.ReadCloser, error) {
	f, ok := t.byName[name]
	if !ok {
		return nil, fmt.Errorf("%s: not in the archive", name)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	return &capReader{r: rc, c: rc, b: t.b}, nil
}

// readAll reads one tree file completely, for a conversion that needs it in memory (a note, its
// metadata). Besides the tree's caps it is bound by Limits.MaxReadBytes; attachments are copied
// with run.copyAttachment instead, which streams them.
func readAll(t Tree, name string) ([]byte, error) {
	rc, err := t.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	c, ok := rc.(*capReader)
	if !ok || c.b.read <= 0 {
		return io.ReadAll(rc)
	}
	return readCapped(rc, c.b.read)
}

// readCapped reads r whole, refusing more than limit bytes (ErrTooLargeToConvert).
func readCapped(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, ErrTooLargeToConvert
	}
	return data, nil
}

// openCapped opens a single-file source (ENEX, JSON, CSV) with a size cap.
func openCapped(p string, lim Limits) (io.ReadCloser, error) {
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, fmt.Errorf("%s: is a folder", p)
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	b := &budget{max: lim.MaxEntryBytes, entry: lim.MaxEntryBytes}
	return &capReader{r: f, c: f, b: b}, nil
}
