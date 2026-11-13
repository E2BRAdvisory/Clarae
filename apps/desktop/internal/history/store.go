package history

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"clarae/shared/pathrules"
)

// Layout under <vault>/.clarae/snapshots (device-local, excluded from sync, index and tree
// by pathrules.IsExcluded):
//
//	blobs/<hh>/<hash>        content, addressed by its hash (shared by identical versions)
//	meta/<pathkey>/<ms>.json one small JSON file per snapshot (path, time, size, hash, reason)
//
// <pathkey> is the first 16 hex characters of SHA-256(vault-relative path). A blob is written
// (and fsynced) before the meta that points at it, so a crash can leave an orphan blob (removed
// by the next prune) but never a meta without content.
const (
	snapshotsRel = pathrules.ConfigDir + "/snapshots"
	blobsDir     = "blobs"
	metaDir      = "meta"
)

var idPattern = regexp.MustCompile(`^([0-9a-f]{16})-([0-9]{1,18})$`)

// ErrNotFound is returned for an unknown snapshot id.
var ErrNotFound = errors.New("snapshot not found")

func pathKey(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:8])
}

func makeID(key string, ms int64) string { return key + "-" + strconv.FormatInt(ms, 10) }

// parseID validates an id coming from the frontend before it is used to build a file path.
func parseID(id string) (key string, ms int64, err error) {
	m := idPattern.FindStringSubmatch(id)
	if m == nil {
		return "", 0, ErrNotFound
	}
	ms, err = strconv.ParseInt(m[2], 10, 64)
	if err != nil {
		return "", 0, ErrNotFound
	}
	return m[1], ms, nil
}

func (h *History) snapDir() string { return filepath.Join(h.root, filepath.FromSlash(snapshotsRel)) }

func (h *History) blobPath(hash string) string {
	return filepath.Join(h.snapDir(), blobsDir, hash[:2], hash)
}

func (h *History) metaDirOf(key string) string { return filepath.Join(h.snapDir(), metaDir, key) }

func (h *History) metaPath(key string, ms int64) string {
	return filepath.Join(h.metaDirOf(key), strconv.FormatInt(ms, 10)+".json")
}

// writeAtomic writes data to abs through a temporary file in the same directory, fsync and rename.
func writeAtomic(abs string, data []byte) error {
	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, pathrules.TmpPrefix+"*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(name)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, abs); err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}

// metaTimes returns the snapshot timestamps (ms) of a path key, newest first.
func (h *History) metaTimes(key string) []int64 {
	ents, err := os.ReadDir(h.metaDirOf(key))
	if err != nil {
		return nil
	}
	out := make([]int64, 0, len(ents))
	for _, e := range ents {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		if ms, err := strconv.ParseInt(strings.TrimSuffix(name, ".json"), 10, 64); err == nil {
			out = append(out, ms)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] > out[j] })
	return out
}

func (h *History) readMeta(key string, ms int64) (Snapshot, error) {
	data, err := os.ReadFile(h.metaPath(key, ms))
	if err != nil {
		return Snapshot{}, err
	}
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return Snapshot{}, fmt.Errorf("corrupt snapshot metadata: %w", err)
	}
	s.ID = makeID(key, ms)
	return s, nil
}

// latest returns the newest snapshot of a path.
func (h *History) latest(path string) (Snapshot, bool) {
	key := pathKey(path)
	for _, ms := range h.metaTimes(key) {
		if s, err := h.readMeta(key, ms); err == nil {
			return s, true
		}
	}
	return Snapshot{}, false
}

// put stores content as a new snapshot (blob first, then meta). The caller holds h.mu.
func (h *History) put(path string, data []byte, hash string, reason Reason, now time.Time) (Snapshot, error) {
	bp := h.blobPath(hash)
	if _, err := os.Stat(bp); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return Snapshot{}, err
		}
		if err := writeAtomic(bp, data); err != nil {
			return Snapshot{}, err
		}
	}
	key := pathKey(path)
	ms := now.UnixMilli()
	for {
		if _, err := os.Stat(h.metaPath(key, ms)); errors.Is(err, fs.ErrNotExist) {
			break
		}
		ms++ // two snapshots of one path in the same millisecond (e.g. periodic + pre-restore)
	}
	s := Snapshot{ID: makeID(key, ms), Path: path, Time: time.UnixMilli(ms).UTC(), Size: int64(len(data)), Hash: hash, Reason: reason}
	meta, err := json.Marshal(s)
	if err != nil {
		return Snapshot{}, err
	}
	if err := writeAtomic(h.metaPath(key, ms), meta); err != nil {
		return Snapshot{}, err
	}
	h.last[path] = s.Time
	return s, nil
}

// allMetas lists every snapshot grouped by path key, newest first within a key.
func (h *History) allMetas() map[string][]Snapshot {
	out := map[string][]Snapshot{}
	ents, err := os.ReadDir(filepath.Join(h.snapDir(), metaDir))
	if err != nil {
		return out
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		key := e.Name()
		for _, ms := range h.metaTimes(key) {
			if s, err := h.readMeta(key, ms); err == nil {
				out[key] = append(out[key], s)
			}
		}
	}
	return out
}

func (h *History) exists(path string) bool {
	abs, _, err := h.fs.Resolve(path)
	if err != nil {
		return false
	}
	_, err = os.Stat(abs)
	return err == nil
}

// Prune applies retention and the total size cap, then removes blobs no snapshot refers to.
// For files that still exist their newest snapshot is always kept; the snapshots of deleted
// files expire with the retention period. It returns the number of snapshots removed.
func (h *History) Prune() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.pruneLocked()
}

func (h *History) pruneLocked() int {
	st := h.settings
	cutoff := h.now().Add(-time.Duration(st.RetentionDays) * 24 * time.Hour)
	removed := 0
	drop := func(s Snapshot) {
		key, ms, err := parseID(s.ID)
		if err == nil && os.Remove(h.metaPath(key, ms)) == nil {
			removed++
		}
	}

	type entry struct {
		s      Snapshot
		latest bool
	}
	var kept []entry
	refs := map[string]int{}
	for _, list := range h.allMetas() {
		live := h.exists(list[0].Path)
		for i, s := range list {
			if _, err := os.Stat(h.blobPath(s.Hash)); err != nil {
				drop(s) // content lost (manual cleanup): the entry is useless
				continue
			}
			expired := s.Time.Before(cutoff) && (i > 0 || !live)
			if expired {
				drop(s)
				continue
			}
			kept = append(kept, entry{s, i == 0})
			refs[s.Hash]++
		}
	}

	// Total size cap: unique blobs only. Older non-latest snapshots go first.
	sizes := map[string]int64{}
	var total int64
	for _, e := range kept {
		if _, ok := sizes[e.s.Hash]; !ok {
			sizes[e.s.Hash] = e.s.Size
			total += e.s.Size
		}
	}
	if limit := int64(st.MaxTotalMB) << 20; total > limit {
		sort.SliceStable(kept, func(i, j int) bool {
			if kept[i].latest != kept[j].latest {
				return !kept[i].latest
			}
			return kept[i].s.Time.Before(kept[j].s.Time)
		})
		for _, e := range kept {
			if total <= limit {
				break
			}
			drop(e.s)
			refs[e.s.Hash]--
			if refs[e.s.Hash] == 0 {
				total -= sizes[e.s.Hash]
			}
		}
	}

	// Garbage collection: unreferenced blobs (dropped snapshots, crash leftovers) and empty dirs.
	// Re-read the surviving metas rather than trusting the arithmetic above.
	live := map[string]bool{}
	for _, list := range h.allMetas() {
		for _, s := range list {
			live[s.Hash] = true
		}
	}
	shards, _ := os.ReadDir(filepath.Join(h.snapDir(), blobsDir))
	for _, shard := range shards {
		if !shard.IsDir() {
			continue
		}
		dir := filepath.Join(h.snapDir(), blobsDir, shard.Name())
		blobs, _ := os.ReadDir(dir)
		for _, b := range blobs {
			if !b.IsDir() && !live[b.Name()] {
				_ = os.Remove(filepath.Join(dir, b.Name()))
			}
		}
	}
	for _, root := range []string{filepath.Join(h.snapDir(), blobsDir), filepath.Join(h.snapDir(), metaDir)} {
		ents, _ := os.ReadDir(root)
		for _, e := range ents {
			if e.IsDir() {
				_ = os.Remove(filepath.Join(root, e.Name())) // fails (and is kept) unless empty
			}
		}
	}
	for p := range h.last {
		delete(h.last, p) // timestamps are re-read lazily from the surviving metas
	}
	return removed
}
