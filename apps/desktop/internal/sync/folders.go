package sync

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"

	"github.com/google/uuid"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// Folder renames (§3.4.7, ADR-0040). In a shared vault a folder renamed here
// is sent as one move_prefix instead of one move per file: the server moves
// every file below it in one transaction and carries along the shares rooted
// at or below it, so the recipients keep their mount. Private vaults keep the
// per-file moves, each with its newly encrypted path: the server cannot see
// folders there (§3.8.5).
//
// On the way in, a run of moves of the changelog that renames a whole local
// folder is applied as one directory rename and one sync.db transaction.

// FolderShareRooter is implemented by remotes that can list the root folders
// of the folder shares of their vault (the owner's view; a mount has none).
// The engine asks for them only when the server refuses a per-file move with
// SHARE_ROOT_MOVE, to send the rename of the share root instead (ADR-0040).
// Without it such a move is parked with the server's explanation.
type FolderShareRooter interface {
	FolderShareRoots(ctx context.Context) ([]string, error)
}

// prefixPair is a folder rename: every file below from moves to the same
// place below to.
type prefixPair struct{ from, to string }

func (p prefixPair) key() string { return p.from + "\n" + p.to }

// outboxKey keeps the operation id of a move_prefix in the outbox, so a retry
// after a lost answer is recognized by the server (idempotency). It starts
// with "/", which no vault path does.
func (p prefixPair) outboxKey() string { return "/move_prefix\n" + p.key() }

// folderMove is a folder rename ready to be sent as one move_prefix.
type folderMove struct {
	prefixPair
	// members are the rows that move with it (StateLocalMoved, at their new path).
	members []File
	// deletes are the file ids of rows below from deleted here: their delete
	// (which needs no path) is sent before the move_prefix, so the server does
	// not move them first and refuse the delete's base revision afterwards.
	deletes []string
}

// forcedMove is the rename of a share root deduced from a per-file move the
// server refused with SHARE_ROOT_MOVE. It is sent even though the old folder
// may still exist here; if that fails too, the move of fileID is parked with
// reason.
type forcedMove struct {
	prefixPair
	fileID string
	reason string
}

// verdict of a candidate folder rename.
type verdict int

const (
	verdictInvalid  verdict = iota // not a folder rename: per-file moves
	verdictOK                      // one move_prefix
	verdictDeferred                // a folder rename, but a remote change of one of its files waits to be merged
)

// renameCandidates lists the folder renames that explain a move from oldPath
// to newPath, widest first: the trailing segments both paths share (at least
// the file name) are what moved along. A changed file name is no folder rename.
func renameCandidates(oldPath, newPath string) []prefixPair {
	olds, news := strings.Split(oldPath, "/"), strings.Split(newPath, "/")
	k := 0
	for k < len(olds)-1 && k < len(news)-1 && olds[len(olds)-1-k] == news[len(news)-1-k] {
		k++
	}
	var out []prefixPair
	for j := k; j >= 1; j-- {
		p := prefixPair{from: strings.Join(olds[:len(olds)-j], "/"), to: strings.Join(news[:len(news)-j], "/")}
		if p.from == p.to || strings.HasPrefix(pathrules.Key(p.to), pathrules.Key(p.from)+"/") {
			continue // the server refuses a folder moving into itself
		}
		out = append(out, p)
	}
	return out
}

// prefixTarget is where the server puts a file at path when from moves to to
// (services/cloud/internal/sync movePrefix: by segments).
func prefixTarget(path string, p prefixPair) string {
	depth := len(strings.Split(p.from, "/"))
	segs := strings.Split(path, "/")
	if len(segs) <= depth {
		return p.to
	}
	return p.to + "/" + strings.Join(segs[depth:], "/")
}

// serverPath is where the server has a row's file, if it has it.
func serverPath(r File) (string, bool) {
	if r.ServerRev == 0 || r.Tombstoned {
		return "", false
	}
	if r.State == StateLocalMoved && r.MovedFrom != "" {
		return r.MovedFrom, true
	}
	return r.Path, true
}

// serverIndex lists the rows by the uniqueness key of their server path, to
// find what the server holds below a folder (it compares keys too).
type serverIndex struct {
	keys  []string
	paths []string
	rows  []File
}

func newServerIndex(rows []File) *serverIndex {
	type entry struct {
		key, path string
		row       File
	}
	var es []entry
	for _, r := range rows {
		if p, ok := serverPath(r); ok {
			es = append(es, entry{pathrules.Key(p), p, r})
		}
	}
	sort.Slice(es, func(i, j int) bool { return es[i].key < es[j].key })
	ix := &serverIndex{keys: make([]string, len(es)), paths: make([]string, len(es)), rows: make([]File, len(es))}
	for i, e := range es {
		ix.keys[i], ix.paths[i], ix.rows[i] = e.key, e.path, e.row
	}
	return ix
}

// below calls fn for every row whose server path is folder or lies below it.
func (ix *serverIndex) below(folder string, fn func(path string, r File)) {
	fk := pathrules.Key(folder)
	for i := sort.SearchStrings(ix.keys, fk); i < len(ix.keys) && strings.HasPrefix(ix.keys[i], fk); i++ {
		if k := ix.keys[i]; k == fk || strings.HasPrefix(k, fk+"/") {
			fn(ix.paths[i], ix.rows[i])
		}
	}
}

// judge decides whether p is a folder rename the server can apply as one
// move_prefix: every file the server has below p.from was moved here to the
// same place below p.to (or deleted here), and the old folder is gone from
// the disk (unless forced). It returns the move when the verdict is OK or
// deferred.
func (e *Engine) judge(ix *serverIndex, p prefixPair, forced bool) (folderMove, verdict) {
	m := folderMove{prefixPair: p}
	invalid, deferred := false, false
	ix.below(p.from, func(path string, r File) {
		if invalid {
			return
		}
		if _, pending := e.candidates[r.FileID]; pending {
			deferred = true
		}
		switch {
		case r.State == StateLocalDeleted:
			m.deletes = append(m.deletes, r.FileID)
		case r.State == StateLocalMoved && r.Path == prefixTarget(path, p):
			m.members = append(m.members, r)
		default:
			invalid = true
		}
	})
	if invalid || len(m.members) == 0 {
		return folderMove{}, verdictInvalid
	}
	if !forced && !e.dirGone(p.from) {
		return folderMove{}, verdictInvalid // files moved one by one: the folder is still here
	}
	if deferred {
		return m, verdictDeferred
	}
	return m, verdictOK
}

// dirGone reports whether no entry named exactly like folder exists on disk
// (exactly: on a case-insensitive file system a folder renamed to another
// case still answers to its old name).
func (e *Engine) dirGone(folder string) bool {
	parent, base := pathrules.Split(folder)
	dir := e.cfg.FS.Root()
	if parent != "" {
		if dir = e.absPath(parent); dir == "" {
			return false
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return errors.Is(err, fs.ErrNotExist)
	}
	for _, de := range entries {
		if n, err := pathrules.Normalize(de.Name()); err == nil && n == base {
			return false
		}
	}
	return true
}

// folderMoves finds the folder renames among the local moves (shared vaults
// only). held are the rows of folder renames that must wait for a remote
// change to be merged first: sending them file by file would split the folder.
func (e *Engine) folderMoves(ctx context.Context) (moves []folderMove, held map[string]bool, err error) {
	if e.cfg.Cipher != nil {
		return nil, nil, nil
	}
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		return nil, nil, err
	}
	var moved []File
	for _, r := range rows {
		if r.State == StateLocalMoved && r.MovedFrom != "" && r.ServerRev > 0 && !r.Tombstoned {
			moved = append(moved, r)
		}
	}
	if len(moved) == 0 && len(e.forcedPrefix) == 0 {
		return nil, nil, nil
	}
	ix := newServerIndex(rows)
	held = map[string]bool{}
	taken := map[string]bool{} // file ids already in a move
	claim := func(m folderMove, v verdict) {
		for _, r := range m.members {
			taken[r.FileID] = true
			if v == verdictDeferred {
				held[r.FileID] = true
			}
		}
		if v == verdictOK {
			for _, id := range m.deletes {
				taken[id] = true
			}
			moves = append(moves, m)
		}
	}
	// Renames of share roots deduced from a SHARE_ROOT_MOVE come first.
	keys := make([]string, 0, len(e.forcedPrefix))
	for k := range e.forcedPrefix {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		f := e.forcedPrefix[k]
		m, v := e.judge(ix, f.prefixPair, true)
		if v == verdictInvalid {
			// The files no longer line up as a rename of the share root: the
			// move stays here, parked with the server's reason (D-04).
			delete(e.forcedPrefix, k)
			if row, ok, err := e.cfg.DB.GetFileByID(ctx, f.fileID); err != nil {
				return nil, nil, err
			} else if ok && row.State == StateLocalMoved {
				if err := e.park(ctx, row, f.reason); err != nil {
					return nil, nil, err
				}
			}
			continue
		}
		claim(m, v)
	}
	judged := map[string]verdict{}
	for _, r := range moved {
		if taken[r.FileID] {
			continue
		}
		for _, p := range renameCandidates(r.MovedFrom, r.Path) {
			if e.noPrefix[p.key()] {
				continue
			}
			if v, seen := judged[p.key()]; seen && v == verdictInvalid {
				continue
			}
			m, v := e.judge(ix, p, false)
			if v != verdictInvalid && overlaps(m, taken) {
				v = verdictInvalid // would carry files another rename already takes
			}
			judged[p.key()] = v
			if v != verdictInvalid {
				claim(m, v)
				break
			}
		}
	}
	return moves, held, nil
}

func overlaps(m folderMove, taken map[string]bool) bool {
	for _, r := range m.members {
		if taken[r.FileID] {
			return true
		}
	}
	for _, id := range m.deletes {
		if taken[id] {
			return true
		}
	}
	return false
}

// preparePrefix builds the move_prefix of a folder rename, reusing the
// operation id of an earlier attempt of the very same rename.
func (e *Engine) preparePrefix(ctx context.Context, m folderMove) (prepared, error) {
	key := m.outboxKey()
	ob, ok, err := e.cfg.DB.GetOutbox(ctx, key)
	if err != nil {
		return prepared{}, err
	}
	id := ob.OpID
	if !ok || ob.Kind != string(syncproto.OpMovePrefix) {
		id = uuid.Must(uuid.NewV7()).String()
		if err := e.cfg.DB.PutOutbox(ctx, OutboxEntry{Path: key, OpID: id, Kind: string(syncproto.OpMovePrefix)}, e.cfg.Now()); err != nil {
			return prepared{}, err
		}
	}
	t := e.cfg.Now()
	mv := m
	return prepared{op: syncproto.Op{OpID: id, Op: syncproto.OpMovePrefix, From: m.from, To: m.to, ClientMtime: &t}, folder: &mv}, nil
}

// applyPrefixResult folds the outcome of a move_prefix into sync_files.
func (e *Engine) applyPrefixResult(ctx context.Context, p prepared, res syncproto.OpResult) (bool, error) {
	m := p.folder
	_ = e.cfg.DB.DeleteOutbox(ctx, m.outboxKey())
	forced, wasForced := e.forcedPrefix[m.key()]
	delete(e.forcedPrefix, m.key())
	if res.Status != syncproto.StatusAccepted {
		// The server would not rename the folder (a name taken there, a file
		// it has below the folder that this device does not know yet, …): the
		// next round sends the moves one by one, each with its own outcome
		// (nor is a narrower rename of the same files tried).
		e.noPrefix[m.key()] = true
		for _, r := range m.members {
			for _, c := range renameCandidates(r.MovedFrom, r.Path) {
				e.noPrefix[c.key()] = true
			}
		}
		e.log.Info().Str("from", m.from).Str("to", m.to).Str("code", string(res.Code)).Str("detail", res.Detail).
			Msg("sync: folder rename refused, sending the moves one by one")
		if wasForced {
			row, ok, err := e.cfg.DB.GetFileByID(ctx, forced.fileID)
			if err != nil {
				return false, err
			}
			if ok && row.State == StateLocalMoved {
				return false, e.park(ctx, row, forced.reason)
			}
		}
		return true, nil
	}
	err := e.cfg.DB.WithTx(ctx, func(tx *DB) error {
		for _, r := range m.members {
			cur, ok, err := tx.GetFileByID(ctx, r.FileID)
			if err != nil {
				return err
			}
			if !ok || cur.State != StateLocalMoved || cur.Path != r.Path {
				continue // changed since it was prepared: the next round looks again
			}
			// Every file got a move revision whose number only the changelog
			// tells: ServerRev stays until the next pull brings them (applyMove
			// then finds each file already in place). A file also edited here
			// sends its content after that, on the new revision.
			cur.MovedFrom = ""
			if cur.Dirty {
				cur.State, cur.Dirty = StateLocalModify, false
			} else {
				cur.State = StateSynced
			}
			cur.Attempts, cur.LastError = 0, ""
			if err := tx.PutFile(ctx, cur); err != nil {
				return err
			}
			if err := tx.DeleteOutbox(ctx, cur.Path); err != nil {
				return err
			}
		}
		return nil
	})
	return true, err
}

// shareRootMove handles a per-file move refused with SHARE_ROOT_MOVE: it was
// the last file of a shared folder leaving it, which to the recipients would
// empty their mount (§3.4.7). When the move is the rename of the share root
// (the file keeps its place below the folder's new name), that rename is sent
// as a move_prefix in the next round, carrying the share along; otherwise the
// move is parked with the server's explanation, the file staying where the
// user put it (D-04), and the status shows it (shareRootNotice).
func (e *Engine) shareRootMove(ctx context.Context, p prepared, row File, res syncproto.OpResult) (bool, error) {
	reason := fmt.Sprintf("%s: %s", res.Code, res.Detail)
	if p.op.Op != syncproto.OpMove || e.cfg.Cipher != nil || row.MovedFrom == "" {
		return false, e.park(ctx, row, reason)
	}
	lister, ok := e.cfg.Remote.(FolderShareRooter)
	if !ok {
		return false, e.park(ctx, row, reason)
	}
	roots, err := lister.FolderShareRoots(ctx)
	if err != nil {
		if isNetwork(err) || ctx.Err() != nil {
			return false, err // the move is tried again, and refused again, next time
		}
		e.log.Warn().Err(err).Msg("sync: cannot list the shares of the vault")
		return false, e.park(ctx, row, reason)
	}
	sort.Slice(roots, func(i, j int) bool { return len(roots[i]) < len(roots[j]) }) // the outermost share first
	oldPath, newPath := row.MovedFrom, row.Path
	for _, root := range roots {
		rk := pathrules.Key(root)
		if !strings.HasPrefix(pathrules.Key(oldPath), rk+"/") || pathrules.HasPrefix(pathrules.Key(newPath), rk) {
			continue
		}
		rel := strings.Join(strings.Split(oldPath, "/")[len(strings.Split(root, "/")):], "/")
		if !strings.HasSuffix(newPath, "/"+rel) {
			continue // the file did not keep its place below the folder: no rename of the root
		}
		pair := prefixPair{from: root, to: strings.TrimSuffix(newPath, "/"+rel)}
		if pair.to == "" || e.noPrefix[pair.key()] || strings.HasPrefix(pathrules.Key(pair.to), rk+"/") {
			continue
		}
		e.forcedPrefix[pair.key()] = forcedMove{prefixPair: pair, fileID: row.FileID, reason: reason}
		row.Attempts++
		return true, e.cfg.DB.PutFile(ctx, row)
	}
	return false, e.park(ctx, row, reason)
}

// shareRootNotice explains, for the status, the moves parked because they
// would have taken the last file out of a shared folder ("" when none).
func (e *Engine) shareRootNotice(ctx context.Context) string {
	rows, err := e.cfg.DB.Files(ctx, StateLocalMoved)
	if err != nil {
		return ""
	}
	var first File
	n := 0
	for _, r := range rows {
		if r.Attempts >= MaxAttempts && strings.HasPrefix(r.LastError, string(syncproto.CodeShareRootMove)) {
			if n == 0 {
				first = r
			}
			n++
		}
	}
	if n == 0 {
		return ""
	}
	msg := fmt.Sprintf("%s was moved out of a shared folder and is not synchronized (rename the shared folder itself, or move the file back): %s",
		first.Path, strings.TrimSpace(strings.TrimPrefix(first.LastError, string(syncproto.CodeShareRootMove)+":")))
	if n > 1 {
		msg += fmt.Sprintf(" (and %d more)", n-1)
	}
	return msg
}

// settleMoved marks a moved row as being where the server has it again.
func settleMoved(r *File) {
	r.MovedFrom = ""
	if r.Dirty {
		r.State, r.Dirty = StateLocalModify, false
	} else {
		r.State = StateSynced
	}
}

// remoteMove is one move of the changelog with what applying it needs.
type remoteMove struct {
	c    transport.Change
	row  File
	path string // the new local path
}

// applyFolderMove applies a run of moves at the start of items as one
// directory rename when together they rename a local folder: the server
// expands a move_prefix (and a client a private folder rename) into one move
// per file, in consecutive changes. It returns how many changes it applied;
// 0 means the caller applies the first change on its own, as usual.
func (e *Engine) applyFolderMove(ctx context.Context, items []transport.Change) (int, error) {
	var run []remoteMove
	var cands []prefixPair
	for _, c := range items {
		if c.Op != "move" {
			break
		}
		row, has, err := e.cfg.DB.GetFileByID(ctx, c.FileID)
		if err != nil {
			return 0, err
		}
		if !has || row.ServerRev >= c.Rev || (row.State != StateSynced && row.State != StateLocalModify) {
			break
		}
		path, err := e.clearPath(ctx, c.FileID, c.Path)
		if err != nil {
			break // applied on its own, which handles the failure
		}
		cs := renameCandidates(row.Path, path)
		if len(run) > 0 {
			cs = intersectPairs(cands, cs)
		}
		if len(cs) == 0 {
			break
		}
		cands = cs
		run = append(run, remoteMove{c: c, row: row, path: path})
	}
	if len(run) < 2 {
		return 0, nil
	}
	for _, p := range cands {
		ok, err := e.renameFolder(ctx, p, run)
		if err != nil {
			return 0, err
		}
		if ok {
			return len(run), nil
		}
	}
	return 0, nil
}

func intersectPairs(a, b []prefixPair) []prefixPair {
	var out []prefixPair
	for _, x := range a {
		for _, y := range b {
			if x == y {
				out = append(out, x)
				break
			}
		}
	}
	return out
}

// renameFolder renames folder p.from to p.to on disk when the run accounts
// for exactly the files the folder holds and sync_files knows nothing else
// below either name; ok is false when the moves must be applied one by one.
func (e *Engine) renameFolder(ctx context.Context, p prefixPair, run []remoteMove) (bool, error) {
	want := make(map[string]bool, len(run))
	for _, m := range run {
		if !pathrules.HasPrefix(m.row.Path, p.from) || m.path != prefixTarget(m.row.Path, p) {
			return false, nil
		}
		want[m.row.Path] = true
	}
	abs := e.absPath(p.from)
	if st, err := os.Lstat(abs); abs == "" || err != nil || !st.IsDir() {
		return false, nil
	}
	caseOnly := strings.EqualFold(p.from, p.to)
	if !caseOnly && e.diskExists(p.to) {
		return false, nil // something is in the way: makeRoom, file by file
	}
	seen := 0
	err := e.cfg.FS.WalkDir(p.from, func(en vault.Entry) error {
		if en.IsDir || pathrules.IsExcluded(en.Path, true) {
			return nil
		}
		if !want[en.Path] {
			return errStopWalk
		}
		seen++
		return nil
	})
	if errors.Is(err, errStopWalk) || seen != len(want) {
		return false, nil // a file here that the run does not move, or a moved one missing
	}
	if err != nil {
		return false, err
	}
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		return false, err
	}
	moving := make(map[string]bool, len(run))
	for _, m := range run {
		moving[m.row.FileID] = true
	}
	for _, r := range rows {
		if moving[r.FileID] {
			continue
		}
		if pathrules.HasPrefix(r.Path, p.from) || (!caseOnly && pathrules.HasPrefix(r.Path, p.to)) {
			return false, nil
		}
	}
	if err := e.cfg.FS.Rename(p.from, p.to); err != nil {
		e.log.Info().Err(err).Str("from", p.from).Str("to", p.to).Msg("sync: folder rename failed, moving the files one by one")
		return false, nil
	}
	err = e.cfg.DB.WithTx(ctx, func(tx *DB) error {
		for _, m := range run {
			row := m.row
			row.Path, row.ServerRev, row.MovedFrom = m.path, m.c.Rev, ""
			if row.State == StateSynced && !e.contentParked(row.FileID, m.c.Rev) {
				row.BaseRev = m.c.Rev // a move leaves the content as the server has it
			}
			if st, err := os.Stat(e.absPath(row.Path)); err == nil {
				row.LocalMtime = st.ModTime().UnixNano()
			}
			if err := tx.PutFile(ctx, row); err != nil {
				return err
			}
		}
		return nil
	})
	// Should the transaction fail, the next scan finds the files at their new
	// paths with their content (a local rename) and the moves, pulled again,
	// settle them.
	return err == nil, err
}

var errStopWalk = errors.New("stop walking")
