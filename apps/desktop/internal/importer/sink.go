package importer

import (
	"errors"
	"fmt"
	"os"
	"path"
	"strings"

	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
)

// Sink receives the files of an import. Implementations choose collision-free paths.
type Sink interface {
	// Reserve picks a free vault path for rel (adding " (1)", " (2)", ... before the
	// extension when it is taken) and keeps it reserved for the rest of the run.
	Reserve(rel string) (string, error)
	// Write stores data at a path returned by Reserve; it never overwrites.
	Write(rel string, data []byte) error
	// Dry reports that nothing is written (preview).
	Dry() bool
}

// NewVaultSink writes through the vault file-system layer: atomic writes, path rules and
// symlink containment, and refusal to overwrite.
func NewVaultSink(fs *vault.FS) Sink { return &vaultSink{fs: fs, taken: map[string]bool{}} }

// NewDryRunSink plans names without touching any file; existing is optional and tells
// whether a vault path is already taken.
func NewDryRunSink(existing func(rel string) bool) Sink {
	return &vaultSink{dry: true, exists: existing, taken: map[string]bool{}}
}

type vaultSink struct {
	fs     *vault.FS
	dry    bool
	exists func(rel string) bool
	taken  map[string]bool // pathrules.Key of reserved paths
}

func (s *vaultSink) Dry() bool { return s.dry }

func (s *vaultSink) isTaken(norm string) bool {
	if s.taken[pathrules.Key(norm)] {
		return true
	}
	if s.fs != nil {
		abs, _, err := s.fs.Resolve(norm)
		if err != nil {
			return true // never write somewhere the vault layer refuses
		}
		_, err = os.Lstat(abs)
		return err == nil
	}
	return s.exists != nil && s.exists(norm)
}

func (s *vaultSink) Reserve(rel string) (string, error) {
	norm, err := pathrules.Normalize(rel)
	if err != nil {
		return "", err
	}
	ext := path.Ext(norm)
	stem := strings.TrimSuffix(norm, ext)
	for i := 0; i < 10000; i++ {
		cand := norm
		if i > 0 {
			c, err := pathrules.Normalize(fmt.Sprintf("%s (%d)%s", stem, i, ext))
			if err != nil {
				return "", err
			}
			cand = c
		}
		if s.isTaken(cand) {
			continue
		}
		s.taken[pathrules.Key(cand)] = true
		return cand, nil
	}
	return "", errors.New("exists: too many files with that name")
}

func (s *vaultSink) Write(rel string, data []byte) error {
	if s.dry {
		return nil
	}
	if !s.taken[pathrules.Key(rel)] {
		return errors.New("internal: write to an unreserved path")
	}
	_, err := s.fs.WriteFile(rel, data, "", true)
	return err
}
