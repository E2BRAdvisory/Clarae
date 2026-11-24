package vault

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"clarae/shared/pathrules"
)

// Settings files of the vault (editor.json, hotkeys.json, ...) live in the configuration folder,
// which a vault of 1.x calls by its former name (pathrules.LegacyConfigDirs, ADR-0052). A vault
// linked to the cloud keeps the settings that sync in the former folder as long as a 1.x client
// may share it, and the sync engine moves them to the current folder later (features.config_dir_v2,
// internal/sync/configmigrate.go). So a settings file has no fixed path, and the application never
// builds one: it asks the FS.
//
//   - ReadConfig looks in the current folder, then in the former one, then in the current one
//     again (a move that happens while the file is looked for, made by a pull or by another
//     program, cannot make it vanish);
//   - WriteConfig writes where the file already is; a file that exists in neither goes to the
//     former folder while the vault is linked and the move is off (SetConfigPolicy), else to the
//     current one;
//   - what never syncs (workspace.json, the databases, cache/, snapshots/) has one place, the
//     current folder.
//
// cfgMu keeps these operations and the move of a file (MoveConfig) apart: a write never lands in
// a folder a file has just left. Lock order: cfgMu, then the locks of the FS (tree, stripes);
// nothing that holds a lock of the FS may take cfgMu.

// SetConfigPolicy sets the function that tells where a settings file that exists in neither folder
// is created: true for the former folder (the vault is linked and the move is not on), false for
// the current one. nil, the default, is false. The function is called before cfgMu is taken, so it
// may take any lock of its own.
func (f *FS) SetConfigPolicy(newInLegacy func() bool) {
	if newInLegacy == nil {
		f.cfgPolicy.Store(nil)
		return
	}
	f.cfgPolicy.Store(&newInLegacy)
}

func (f *FS) configInLegacy() bool {
	if p := f.cfgPolicy.Load(); p != nil {
		return (*p)()
	}
	return false
}

// configName validates the name of a settings file (a path inside the configuration folder, as
// the allow-list of the bindings spells it: "editor.json", "templates/daily.md") and returns it
// normalized.
func configName(name string) (string, error) {
	n, err := pathrules.Normalize(pathrules.ConfigDir + "/" + name)
	if err != nil {
		return "", err
	}
	rel, ok := pathrules.ConfigRel(n)
	if !ok {
		return "", &pathrules.Error{Path: name, Reason: "not inside the configuration folder"}
	}
	return rel, nil
}

// localOnly reports whether a settings file never syncs and so has a single place.
func localOnly(name string) bool { return pathrules.IsExcluded(pathrules.ConfigDir+"/"+name, false) }

// placeDirs are the folders a settings file may be in, the current one first: a file that never
// syncs has no other.
func placeDirs(name string) []string {
	if localOnly(name) {
		return []string{pathrules.ConfigDir}
	}
	return append([]string{pathrules.ConfigDir}, pathrules.LegacyConfigDirs...)
}

// readDirs is the order a read looks in: the places, and the current folder once more (a file
// moved from the former folder to the current one while the read was looking is found there).
func readDirs(name string) []string {
	dirs := placeDirs(name)
	if len(dirs) > 1 {
		dirs = append(dirs, pathrules.ConfigDir)
	}
	return dirs
}

// ConfigPath returns the vault-relative path where the settings file name is, or where it would
// be created.
func (f *FS) ConfigPath(name string) (string, error) {
	n, err := configName(name)
	if err != nil {
		return "", err
	}
	legacyNew := f.configInLegacy()
	f.cfgMu.RLock()
	defer f.cfgMu.RUnlock()
	rel, _, err := f.locateConfig(n, legacyNew)
	return rel, err
}

// locateConfig finds the settings file name (caller holds cfgMu). exists tells whether it is
// there; when it is not, rel is where it would be created.
func (f *FS) locateConfig(name string, legacyNew bool) (rel string, exists bool, err error) {
	for _, dir := range placeDirs(name) {
		rel := dir + "/" + name
		abs, _, err := f.Resolve(rel)
		if err != nil {
			return "", false, err
		}
		switch _, err := os.Lstat(abs); {
		case err == nil:
			return rel, true, nil
		case !errors.Is(err, fs.ErrNotExist):
			return "", false, err
		}
	}
	if legacyNew && !localOnly(name) {
		return pathrules.LegacyConfigDirs[0] + "/" + name, false, nil
	}
	return pathrules.ConfigDir + "/" + name, false, nil
}

// ReadConfig reads the settings file name (see the comment at the top of this file). A file that
// does not exist gives an error that satisfies errors.Is(err, ErrNotFound). Content.Path is the
// path it was read from.
func (f *FS) ReadConfig(name string) (Content, error) {
	n, err := configName(name)
	if err != nil {
		return Content{}, err
	}
	f.cfgMu.RLock()
	defer f.cfgMu.RUnlock()
	for _, dir := range readDirs(n) {
		c, err := f.ReadFile(dir + "/" + n)
		if err == nil {
			return c, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return Content{}, err
		}
	}
	return Content{}, ErrNotFound
}

// configWriteAttempts bounds the retries of WriteConfig when the file moved between the moment
// its place was found and the write.
const configWriteAttempts = 3

// WriteConfig writes the settings file name atomically, with the semantics of WriteFile
// (expectedHash, create) applied to the file wherever it is. An overwrite never creates a second
// copy: it is tied to the content found at the place, and when the file moved meanwhile (a pull
// moved it from the former folder to the current one) the place is looked for again.
func (f *FS) WriteConfig(name string, data []byte, expectedHash string, create bool) (Content, error) {
	n, err := configName(name)
	if err != nil {
		return Content{}, err
	}
	legacyNew := f.configInLegacy()
	for attempt := 1; ; attempt++ {
		c, norm, moved, err := f.writeConfigOnce(n, data, expectedHash, create, legacyNew)
		if err != nil {
			if errors.Is(err, ErrHashMismatch) && attempt < configWriteAttempts && moved {
				continue // the file moved since it was found: look for it again
			}
			return Content{}, err
		}
		f.changed(norm) // outside the locks: the callback may call back into the FS
		return c, nil
	}
}

// writeConfigOnce is one attempt of WriteConfig; moved is set when the attempt failed because
// the file was not at the place found for it any more.
func (f *FS) writeConfigOnce(name string, data []byte, expectedHash string, create, legacyNew bool) (Content, string, bool, error) {
	f.cfgMu.RLock()
	defer f.cfgMu.RUnlock()
	rel, exists, err := f.locateConfig(name, legacyNew)
	if err != nil {
		return Content{}, "", false, err
	}
	abs, norm, err := f.Resolve(rel)
	if err != nil {
		return Content{}, "", false, err
	}
	// A blind overwrite of a file that was found is not allowed to create it: should the file have
	// been moved away since, the write would bring back the folder it left.
	c, err := f.writeFile(abs, norm, data, expectedHash, create, exists && expectedHash == "")
	if errors.Is(err, ErrHashMismatch) {
		// Not at the place it was found: it moved (or was deleted) meanwhile.
		_, lerr := os.Lstat(abs)
		return Content{}, "", lerr != nil, err
	}
	return c, norm, false, err
}

// MoveConfig moves the settings file at fromRel, in a former configuration folder, to the same
// name in the current one, for the sync engine (features.config_dir_v2). It returns the new path.
// moved is false, with no error, when there is nothing to do: the source is gone or is not a
// regular file, the name is a local-only one, or the current folder already has a file of that
// name (the current one wins and nothing is overwritten). With a non-empty expectedHash the source
// must still hash to it: a file changed since the engine last saw it is left alone
// (ErrHashMismatch). Folders left empty behind the file are removed.
func (f *FS) MoveConfig(fromRel, expectedHash string) (toRel string, moved bool, err error) {
	from, err := pathrules.Normalize(fromRel)
	if err != nil {
		return "", false, err
	}
	name, ok := pathrules.ConfigRel(from)
	if !ok || strings.HasPrefix(from, pathrules.ConfigDir+"/") || localOnly(name) {
		return "", false, nil
	}
	toRel = pathrules.ConfigDir + "/" + name
	moved, err = f.moveConfigLocked(from, toRel, expectedHash)
	if err != nil || !moved {
		return "", false, err
	}
	f.changed(from, toRel) // outside the locks: the callback may call back into the FS
	return toRel, true, nil
}

func (f *FS) moveConfigLocked(from, toRel, expectedHash string) (bool, error) {
	f.cfgMu.Lock()
	defer f.cfgMu.Unlock()
	fromAbs, _, err := f.Resolve(from)
	if err != nil {
		return false, err
	}
	toAbs, _, err := f.Resolve(toRel)
	if err != nil {
		return false, err
	}
	if st, err := os.Lstat(fromAbs); errors.Is(err, fs.ErrNotExist) || (err == nil && !st.Mode().IsRegular()) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	if _, err := os.Lstat(toAbs); err == nil {
		return false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	if expectedHash != "" {
		h, _, err := f.HashFile(from)
		if err != nil {
			return false, err
		}
		if h != expectedHash {
			return false, ErrHashMismatch
		}
	}
	if err := f.rename(fromAbs, toAbs); err != nil {
		if errors.Is(err, ErrExists) || errors.Is(err, fs.ErrNotExist) {
			return false, nil // somebody else got there first: nothing was overwritten
		}
		return false, err
	}
	removeEmptyDirs(filepath.Dir(fromAbs), filepath.Join(f.root, filepath.FromSlash(strings.SplitN(from, "/", 2)[0])))
	return true, nil
}

// RemoveShadowedConfig takes the settings file at fromRel, in a former configuration folder, off
// the disk because the current folder has the file of that name already (the sync engine, when it
// deletes the shadowed row on the server, features.config_dir_v2). With keepCopy the file goes to
// the vault's .trash/ (a version that differs from the current one is never lost), else it is
// deleted. The source must still hash to expectedHash (ErrHashMismatch otherwise: it changed since
// the engine last saw it, and an unsent edit is never removed). removed is false, with no error,
// when there is nothing to do: the source is gone, is not a regular file, is in the current folder
// or is a local-only name. Folders left empty behind the file are removed.
func (f *FS) RemoveShadowedConfig(fromRel, expectedHash string, keepCopy bool) (removed bool, err error) {
	from, err := pathrules.Normalize(fromRel)
	if err != nil {
		return false, err
	}
	name, ok := pathrules.ConfigRel(from)
	if !ok || strings.HasPrefix(from, pathrules.ConfigDir+"/") || localOnly(name) || expectedHash == "" {
		return false, nil
	}
	removed, err = f.removeShadowedLocked(from, expectedHash, keepCopy)
	if err != nil || !removed {
		return false, err
	}
	f.changed(from) // outside the locks: the callback may call back into the FS
	return true, nil
}

func (f *FS) removeShadowedLocked(from, expectedHash string, keepCopy bool) (bool, error) {
	f.cfgMu.Lock()
	defer f.cfgMu.Unlock()
	fromAbs, _, err := f.Resolve(from)
	if err != nil {
		return false, err
	}
	if st, err := os.Lstat(fromAbs); errors.Is(err, fs.ErrNotExist) || (err == nil && !st.Mode().IsRegular()) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	h, _, err := f.HashFile(from)
	if err != nil {
		return false, err
	}
	if h != expectedHash {
		return false, ErrHashMismatch
	}
	if keepCopy {
		if _, err := f.trash(fromAbs, from); err != nil {
			return false, err
		}
	} else {
		unlock := f.lockTree()
		err := os.Remove(fromAbs)
		unlock()
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return false, err
		}
	}
	removeEmptyDirs(filepath.Dir(fromAbs), filepath.Join(f.root, filepath.FromSlash(strings.SplitN(from, "/", 2)[0])))
	return true, nil
}

// removeEmptyDirs removes dir and its parents up to root (included) while they are empty
// (os.Remove refuses any other).
func removeEmptyDirs(dir, root string) {
	for strings.HasPrefix(dir, root) {
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

// ShelveConfig moves the settings of the current configuration folder that sync to the former
// folder, for a vault that has just been linked to the cloud while clients of 1.x may share it
// (features.config_dir_v2 off): a vault that was not linked adopted its settings into the current
// folder (vaultdir.AdoptSettings), and a 1.x client of the cloud vault would neither read them nor
// leave them alone. A file the former folder already has stays where it is. What never syncs does
// not move. It returns the number of files moved; folders left empty go.
func (f *FS) ShelveConfig() (int, error) {
	moves, err := f.shelveLocked()
	for _, m := range moves {
		f.changed(m[0], m[1]) // outside the locks: the callback may call back into the FS
	}
	return len(moves), err
}

// shelveLocked moves the files and returns the (from, to) pairs it moved.
func (f *FS) shelveLocked() (moves [][2]string, err error) {
	f.cfgMu.Lock()
	defer f.cfgMu.Unlock()
	root, err := f.configRoot()
	if err != nil || root == "" {
		return nil, err
	}
	var names []string
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == root {
			return err
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return rerr
		}
		name := filepath.ToSlash(rel)
		if localOnly(name) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			names = append(names, name)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		from := pathrules.ConfigDir + "/" + name
		to := pathrules.LegacyConfigDirs[0] + "/" + name
		fromAbs, _, rerr := f.Resolve(from)
		if rerr != nil {
			return moves, rerr
		}
		toAbs, _, rerr := f.Resolve(to)
		if rerr != nil {
			return moves, rerr
		}
		if _, lerr := os.Lstat(toAbs); lerr == nil {
			continue // the former folder has it: it wins, nothing is overwritten
		} else if !errors.Is(lerr, fs.ErrNotExist) {
			return moves, lerr
		}
		if rerr := f.rename(fromAbs, toAbs); rerr != nil {
			if errors.Is(rerr, ErrExists) || errors.Is(rerr, fs.ErrNotExist) {
				continue
			}
			return moves, rerr
		}
		moves = append(moves, [2]string{from, to})
		if dir := filepath.Dir(fromAbs); dir != root {
			removeEmptyDirs(dir, root+string(filepath.Separator))
		}
	}
	return moves, nil
}

// configRoot is the absolute current configuration folder, "" when the vault has none.
func (f *FS) configRoot() (string, error) {
	abs, _, err := f.Resolve(pathrules.ConfigDir)
	if err != nil {
		return "", err
	}
	if st, err := os.Lstat(abs); err != nil || !st.IsDir() {
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	return abs, nil
}

// WalkConfig visits the files below the folder name of the configuration folder ("templates"), in
// the current folder and in the former ones (see the comment at the top of this file). rel is the
// path of a file inside that folder ("Work/Daily.md"), e its entry, whose Path is where the file is
// in the vault. A file both folders have is reported once, from the current one: the one ReadConfig
// reads. Folders are not reported, and what Walk leaves out (excluded entries, symlinks) is left
// out here too. A folder that does not exist holds nothing. fn runs outside the locks, so it may
// call back into the FS.
func (f *FS) WalkConfig(name string, fn func(rel string, e Entry) error) error {
	n, err := configName(name)
	if err != nil {
		return err
	}
	type found struct {
		rel string
		e   Entry
	}
	var files []found
	collect := func() error {
		f.cfgMu.RLock()
		defer f.cfgMu.RUnlock()
		seen := map[string]bool{}
		for _, dir := range placeDirs(n) {
			base := dir + "/" + n
			err := f.WalkDir(base, func(e Entry) error {
				if e.IsDir {
					return nil
				}
				rel := strings.TrimPrefix(e.Path, base+"/")
				if key := pathrules.Key(rel); !seen[key] {
					seen[key] = true
					files = append(files, found{rel, e})
				}
				return nil
			})
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
		return nil
	}
	if err := collect(); err != nil {
		return err
	}
	for _, x := range files {
		if err := fn(x.rel, x.e); err != nil {
			return err
		}
	}
	return nil
}

// AdoptConfig moves the file of the vault at fromRel into the configuration folder, under name
// ("templates/Daily.md"), to the place WriteConfig would create a file of that name at (the former
// folder while the vault is linked and the move is off), and returns its new path. Nothing is
// overwritten: ErrExists when either folder already has a file of that name. The source must be a
// regular file outside the configuration folder, and name one that syncs. The folders left empty
// behind the file stay: they are the user's.
func (f *FS) AdoptConfig(fromRel, name string) (toRel string, err error) {
	n, err := configName(name)
	if err != nil {
		return "", err
	}
	if localOnly(n) {
		return "", &pathrules.Error{Path: name, Reason: "a file that never syncs cannot be adopted"}
	}
	fromAbs, from, err := f.Resolve(fromRel)
	if err != nil {
		return "", err
	}
	if pathrules.IsConfigPath(from) {
		return "", &pathrules.Error{Path: fromRel, Reason: "already inside the configuration folder"}
	}
	toRel, err = f.adoptLocked(fromAbs, n, f.configInLegacy())
	if err != nil {
		return "", err
	}
	f.changed(from, toRel) // outside the locks: the callback may call back into the FS
	return toRel, nil
}

func (f *FS) adoptLocked(fromAbs, name string, legacyNew bool) (string, error) {
	f.cfgMu.Lock()
	defer f.cfgMu.Unlock()
	rel, exists, err := f.locateConfig(name, legacyNew)
	if err != nil {
		return "", err
	}
	if exists {
		return "", ErrExists
	}
	toAbs, toRel, err := f.Resolve(rel)
	if err != nil {
		return "", err
	}
	if st, err := os.Lstat(fromAbs); err != nil {
		return "", err
	} else if !st.Mode().IsRegular() {
		return "", &pathrules.Error{Path: name, Reason: "only a regular file can be adopted"}
	}
	if err := f.rename(fromAbs, toAbs); err != nil {
		return "", err
	}
	return toRel, nil
}
