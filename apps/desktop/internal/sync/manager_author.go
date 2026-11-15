package sync

import "context"

// SameAuthorOnDisk says whether the text a vault file holds on disk (diskHash, the digest the vault gives it)
// is the work of the account this vault is linked with. The editor asks it before it merges its unsaved text
// with a newer version of the file: D-04 guarantees a merge between different authors only for notes, so for a
// drawing, a canvas or a base it must know whether the other side is the user's own.
//
//   - A vault that is not linked, and a private one (not shareable, D-02), has one author: true.
//   - On a shared vault (one's own or a mount), content that is not the version the server sent (what the row
//     of sync.db last saw on disk differs, or the row says it has changes to send) was written here: another
//     panel, another app, a restore. That is the user's: true.
//   - Content that is the server's version belongs to the author of that revision (File.HeadAuthor): true only
//     when it is this account. An author that is not known (a row from before the column, a bootstrap) and a
//     file that is parked in conflict count as another one: the caller keeps the cautious path then.
//
// A failure to read sync.db answers false, for the same reason. It reads one row and takes no cycle lock.
func (m *Manager) SameAuthorOnDisk(ctx context.Context, localID, path, diskHash string) bool {
	m.mu.Lock()
	mv := m.vaults[localID]
	var (
		eng  *Engine
		kind string
	)
	if mv != nil {
		eng, kind = mv.engine, mv.kind
	}
	m.mu.Unlock()
	if mv == nil || eng == nil || kind == "private" {
		return true
	}
	row, ok, err := mv.db.GetFile(ctx, path)
	if err != nil {
		return false
	}
	if !ok {
		return true // a file the sync has never seen: written here
	}
	if row.LocalHash != diskHash {
		return true // on disk since the last scan: not the server's version
	}
	switch {
	case row.State == StateSynced, row.State == StateLocalMoved && !row.Dirty:
		// the content is the server's
	case row.State == StateConflict:
		return false
	default:
		return true // local_new, local_modified, a moved file with edits: our own content
	}
	return row.HeadAuthor != "" && row.HeadAuthor == eng.cfg.UserID
}
