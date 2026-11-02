package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// FS stores objects as files below a root directory.
type FS struct{ root string }

// NewFS creates the root directory if needed.
func NewFS(root string) (*FS, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &FS{root: abs}, nil
}

func (f *FS) path(key string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(key))
	if key == "" || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("storage: invalid key %q", key)
	}
	return filepath.Join(f.root, clean), nil
}

// Put writes atomically (temporary file + rename).
func (f *FS) Put(_ context.Context, key string, r io.Reader, size int64) error {
	p, err := f.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".put-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	n, err := io.Copy(tmp, r)
	if err != nil {
		_ = tmp.Close()
		return err
	}
	if size >= 0 && n != size {
		_ = tmp.Close()
		return fmt.Errorf("storage: wrote %d bytes, expected %d", n, size)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

// Get opens a byte range.
func (f *FS) Get(_ context.Context, key string, offset, length int64) (io.ReadCloser, error) {
	p, err := f.path(key)
	if err != nil {
		return nil, err
	}
	fh, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if offset > 0 {
		if _, err := fh.Seek(offset, io.SeekStart); err != nil {
			_ = fh.Close()
			return nil, err
		}
	}
	if length < 0 {
		return fh, nil
	}
	return &limited{Reader: io.LimitReader(fh, length), c: fh}, nil
}

type limited struct {
	io.Reader
	c io.Closer
}

func (l *limited) Close() error { return l.c.Close() }

// Size returns the file size.
func (f *FS) Size(_ context.Context, key string) (int64, error) {
	p, err := f.path(key)
	if err != nil {
		return 0, err
	}
	st, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// Delete removes the file.
func (f *FS) Delete(_ context.Context, key string) error {
	p, err := f.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// List walks the files below prefix. Objects are files: the temporary files of
// a Put in progress are listed too (the caller decides by age).
func (f *FS) List(ctx context.Context, prefix string, fn func(ObjectInfo) error) error {
	// The prefix is a key prefix, not necessarily a directory: walk the
	// directory that contains it and filter.
	dir := path.Dir(prefix + "x")
	start, err := f.path(dir)
	if dir == "." {
		start, err = f.root, nil
	}
	if err != nil {
		return err
	}
	err = filepath.WalkDir(start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(f.root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := d.Info()
		if errors.Is(err, fs.ErrNotExist) {
			return nil // deleted meanwhile
		}
		if err != nil {
			return err
		}
		return fn(ObjectInfo{Key: key, Size: info.Size(), Modified: info.ModTime()})
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// Ping checks the root is accessible.
func (f *FS) Ping(context.Context) error {
	_, err := os.Stat(f.root)
	return err
}
