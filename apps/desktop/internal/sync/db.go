// Package sync is the desktop synchronization engine (§3.4): it detects local
// changes, pulls the server changelog, merges concurrent edits with
// shared/go/merge and pushes what is left, for shared vaults and for private
// (end-to-end encrypted) ones. The server only orders and stores; every
// decision about content happens here.
package sync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// State is the relation of a local file to the server (§3.4.3).
type State string

// File states.
const (
	StateSynced       State = "synced"
	StateLocalModify  State = "local_modified"
	StateLocalNew     State = "local_new"
	StateLocalDeleted State = "local_deleted"
	StateLocalMoved   State = "local_moved"
	StateConflict     State = "conflict"
)

// MaxAttempts bounds consecutive failed reconciliations of one file before it
// is parked in StateConflict for manual resolution (§3.4.5).
const MaxAttempts = 5

// File is one row of sync_files.
type File struct {
	Path       string
	FileID     string
	ServerRev  int
	BaseRev    int
	ServerHash string
	LocalHash  string
	LocalSize  int64
	LocalMtime int64
	State      State
	MovedFrom  string
	Dirty      bool
	Tombstoned bool
	ConflictOf string
	Attempts   int
	LastError  string
}

// querier is what *sql.DB and *sql.Tx have in common.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// DB wraps sync.db. Inside WithTx the same methods run on the transaction.
type DB struct {
	sdb *sql.DB
	db  querier
	tx  bool
}

// NewDB wraps an open sync.db (see store.Open with store.KindSync).
func NewDB(db *sql.DB) *DB { return &DB{sdb: db, db: db} }

// WithTx runs fn in one sync.db transaction: every method of the *DB it
// receives is part of it, and it commits only when fn returns nil. The
// connection pool has a single connection, so fn must not use the outer *DB
// (it would wait for the transaction forever). Nested calls join the
// transaction already open.
func (d *DB) WithTx(ctx context.Context, fn func(tx *DB) error) error {
	if d.tx {
		return fn(d)
	}
	tx, err := d.sdb.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(&DB{sdb: d.sdb, db: tx, tx: true}); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

const fileCols = `path, file_id, server_rev, base_rev, server_hash, local_hash, local_size, local_mtime, state, moved_from, dirty, tombstoned, conflict_of, attempts, last_error`

func scanFile(sc interface{ Scan(...any) error }) (File, error) {
	var f File
	var state string
	var dirty, tomb int
	err := sc.Scan(&f.Path, &f.FileID, &f.ServerRev, &f.BaseRev, &f.ServerHash, &f.LocalHash, &f.LocalSize, &f.LocalMtime, &state, &f.MovedFrom, &dirty, &tomb, &f.ConflictOf, &f.Attempts, &f.LastError)
	f.State, f.Dirty, f.Tombstoned = State(state), dirty != 0, tomb != 0
	return f, err
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// GetFile returns the row for path.
func (d *DB) GetFile(ctx context.Context, path string) (File, bool, error) {
	f, err := scanFile(d.db.QueryRowContext(ctx, `SELECT `+fileCols+` FROM sync_files WHERE path = ?`, path))
	if errors.Is(err, sql.ErrNoRows) {
		return File{}, false, nil
	}
	return f, err == nil, err
}

// GetFileByID returns the row for a file id.
func (d *DB) GetFileByID(ctx context.Context, id string) (File, bool, error) {
	f, err := scanFile(d.db.QueryRowContext(ctx, `SELECT `+fileCols+` FROM sync_files WHERE file_id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return File{}, false, nil
	}
	return f, err == nil, err
}

// Files returns every row, optionally restricted to states.
func (d *DB) Files(ctx context.Context, states ...State) ([]File, error) {
	q := `SELECT ` + fileCols + ` FROM sync_files`
	args := []any{}
	if len(states) > 0 {
		q += ` WHERE state IN (`
		for i, s := range states {
			if i > 0 {
				q += ","
			}
			q += "?"
			args = append(args, string(s))
		}
		q += `)`
	}
	q += ` ORDER BY path`
	rows, err := d.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []File
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// PutFile inserts or replaces a row (keyed by file_id so a path change is an update).
func (d *DB) PutFile(ctx context.Context, f File) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO sync_files (`+fileCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(file_id) DO UPDATE SET path=excluded.path, server_rev=excluded.server_rev, base_rev=excluded.base_rev, server_hash=excluded.server_hash,
		  local_hash=excluded.local_hash, local_size=excluded.local_size, local_mtime=excluded.local_mtime, state=excluded.state,
		  moved_from=excluded.moved_from, dirty=excluded.dirty, tombstoned=excluded.tombstoned, conflict_of=excluded.conflict_of,
		  attempts=excluded.attempts, last_error=excluded.last_error`,
		f.Path, f.FileID, f.ServerRev, f.BaseRev, f.ServerHash, f.LocalHash, f.LocalSize, f.LocalMtime, string(f.State), f.MovedFrom,
		b2i(f.Dirty), b2i(f.Tombstoned), f.ConflictOf, f.Attempts, f.LastError)
	return err
}

// DeleteFile removes the row of a file id.
func (d *DB) DeleteFile(ctx context.Context, fileID string) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM sync_files WHERE file_id = ?`, fileID)
	return err
}

// Meta reads a metadata value ("" when absent).
func (d *DB) Meta(ctx context.Context, key string) (string, error) {
	var v string
	err := d.db.QueryRowContext(ctx, `SELECT value FROM sync_meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetMeta writes a metadata value.
func (d *DB) SetMeta(ctx context.Context, key, value string) error {
	_, err := d.db.ExecContext(ctx, `INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// DeleteMeta removes a key.
func (d *DB) DeleteMeta(ctx context.Context, key string) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM sync_meta WHERE key = ?`, key)
	return err
}

// Cursor returns the last applied changelog position.
func (d *DB) Cursor(ctx context.Context) (int64, error) {
	var n int64
	err := d.db.QueryRowContext(ctx, `SELECT last_seq FROM sync_cursor WHERE id = 1`).Scan(&n)
	return n, err
}

// CursorID returns the id of the change at the cursor, as the server reported
// it ("" when unknown). It is sent with the cursor so that the server can
// tell a seq it handed out again after a restore of its database (ADR-0046).
func (d *DB) CursorID(ctx context.Context) (string, error) {
	var id string
	err := d.db.QueryRowContext(ctx, `SELECT last_id FROM sync_cursor WHERE id = 1`).Scan(&id)
	return id, err
}

// SetCursor stores the position and the id of the change at it ("" when the
// server reported none). It only moves forward unless force is set (bootstrap
// from the manifest may legitimately reset it); at the same position it only
// fills in an id that was unknown.
func (d *DB) SetCursor(ctx context.Context, seq int64, id string, force bool) error {
	if force {
		_, err := d.db.ExecContext(ctx, `UPDATE sync_cursor SET last_seq = ?, last_id = ? WHERE id = 1`, seq, id)
		return err
	}
	_, err := d.db.ExecContext(ctx, `UPDATE sync_cursor SET last_seq = ?, last_id = ? WHERE id = 1 AND (last_seq < ? OR (last_seq = ? AND last_id = ''))`, seq, id, seq, seq)
	return err
}

// OutboxEntry is a prepared operation.
type OutboxEntry struct {
	Path      string
	OpID      string
	Kind      string
	LocalHash string
	BlobHash  string
	UploadURL string
	Attempts  int
}

// GetOutbox returns the prepared operation of a path.
func (d *DB) GetOutbox(ctx context.Context, path string) (OutboxEntry, bool, error) {
	var o OutboxEntry
	err := d.db.QueryRowContext(ctx, `SELECT path, op_id, kind, local_hash, blob_hash, upload_url, attempts FROM outbox WHERE path = ?`, path).
		Scan(&o.Path, &o.OpID, &o.Kind, &o.LocalHash, &o.BlobHash, &o.UploadURL, &o.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return OutboxEntry{}, false, nil
	}
	return o, err == nil, err
}

// PutOutbox stores or replaces the prepared operation of a path.
func (d *DB) PutOutbox(ctx context.Context, o OutboxEntry, now time.Time) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO outbox (path, op_id, kind, local_hash, blob_hash, upload_url, created_at, attempts) VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET op_id=excluded.op_id, kind=excluded.kind, local_hash=excluded.local_hash,
		  blob_hash=excluded.blob_hash, upload_url=excluded.upload_url, attempts=excluded.attempts`,
		o.Path, o.OpID, o.Kind, o.LocalHash, o.BlobHash, o.UploadURL, now.UnixNano(), o.Attempts)
	return err
}

// DeleteOutbox drops a path's prepared operation.
func (d *DB) DeleteOutbox(ctx context.Context, path string) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM outbox WHERE path = ?`, path)
	return err
}

// PruneOutbox drops prepared operations of files that no longer have anything to send.
func (d *DB) PruneOutbox(ctx context.Context) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM outbox WHERE path NOT IN (SELECT path FROM sync_files WHERE state <> 'synced')`)
	return err
}

// OutboxCount is the number of prepared operations.
func (d *DB) OutboxCount(ctx context.Context) (int, error) {
	var n int
	err := d.db.QueryRowContext(ctx, `SELECT count(*) FROM outbox`).Scan(&n)
	return n, err
}

// Conflict is a recorded conflict (§3.4.5), shown in the resolution view.
type Conflict struct {
	ID        int64     `json:"id"`
	FileID    string    `json:"fileId"`
	Path      string    `json:"path"`
	CopyPath  string    `json:"copyPath"`
	Strategy  string    `json:"strategy"`
	LocalHash string    `json:"localHash"`
	RemoteRev int       `json:"remoteRev"`
	Detail    string    `json:"detail"`
	CreatedAt time.Time `json:"createdAt"`
	Status    string    `json:"status"`
}

// AddConflict records a conflict and returns it with its id.
func (d *DB) AddConflict(ctx context.Context, c Conflict) (Conflict, error) {
	res, err := d.db.ExecContext(ctx, `INSERT INTO conflicts (file_id, path, copy_path, strategy, local_hash, remote_rev, detail, created_at) VALUES (?,?,?,?,?,?,?,?)`,
		c.FileID, c.Path, c.CopyPath, c.Strategy, c.LocalHash, c.RemoteRev, c.Detail, c.CreatedAt.UnixNano())
	if err != nil {
		return c, err
	}
	c.ID, _ = res.LastInsertId()
	c.Status = "open"
	return c, nil
}

// Conflicts lists conflicts with the given status ("" = all), newest first.
func (d *DB) Conflicts(ctx context.Context, status string) ([]Conflict, error) {
	q := `SELECT id, file_id, path, copy_path, strategy, local_hash, remote_rev, detail, created_at, status FROM conflicts`
	args := []any{}
	if status != "" {
		q += ` WHERE status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY id DESC`
	rows, err := d.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Conflict
	for rows.Next() {
		var c Conflict
		var ts int64
		if err := rows.Scan(&c.ID, &c.FileID, &c.Path, &c.CopyPath, &c.Strategy, &c.LocalHash, &c.RemoteRev, &c.Detail, &ts, &c.Status); err != nil {
			return nil, err
		}
		c.CreatedAt = time.Unix(0, ts)
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetConflictStatus closes a conflict.
func (d *DB) SetConflictStatus(ctx context.Context, id int64, status string) error {
	_, err := d.db.ExecContext(ctx, `UPDATE conflicts SET status = ? WHERE id = ?`, status, id)
	return err
}

// OpenConflictCount counts unresolved conflicts.
func (d *DB) OpenConflictCount(ctx context.Context) (int, error) {
	var n int
	err := d.db.QueryRowContext(ctx, `SELECT count(*) FROM conflicts WHERE status = 'open'`).Scan(&n)
	return n, err
}

// PendingCount is the number of files that still differ from the server.
func (d *DB) PendingCount(ctx context.Context) (int, error) {
	var n int
	err := d.db.QueryRowContext(ctx, `SELECT count(*) FROM sync_files WHERE state <> 'synced'`).Scan(&n)
	return n, err
}

// Meta keys.
const (
	MetaCloudVault   = "cloud_vault_id"
	MetaKind         = "kind"
	MetaServerURL    = "server_url"
	MetaDeviceID     = "device_id"
	MetaUserID       = "user_id"
	MetaVaultName    = "vault_name"
	MetaBootstrapped = "bootstrapped"
	MetaPaused       = "paused"
	MetaLinkedAt     = "linked_at"
	MetaPollSeconds  = "poll_s"       // user-chosen polling interval (0 = automatic)
	MetaLastScan     = "last_scan_ns" // start of the last complete local scan (Unix ns)
)

// MetaInt reads an integer metadata value.
func (d *DB) MetaInt(ctx context.Context, key string) (int, error) {
	v, err := d.Meta(ctx, key)
	if err != nil || v == "" {
		return 0, err
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("meta %s: %w", key, err)
	}
	return n, nil
}

// PutPending stores (or replaces) the remote change parked for a file until
// its merge succeeds. A change older than the one already parked is ignored.
func (d *DB) PutPending(ctx context.Context, c transportChange, now time.Time) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = d.db.ExecContext(ctx, `
		INSERT INTO pending_remote (file_id, rev, change, created_at) VALUES (?,?,?,?)
		ON CONFLICT(file_id) DO UPDATE SET rev=excluded.rev, change=excluded.change
		WHERE excluded.rev >= pending_remote.rev`,
		c.FileID, c.Rev, string(data), now.UnixNano())
	return err
}

// DeletePending drops the parked change of a file.
func (d *DB) DeletePending(ctx context.Context, fileID string) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM pending_remote WHERE file_id = ?`, fileID)
	return err
}

// Pending returns every parked remote change, keyed by file id.
func (d *DB) Pending(ctx context.Context) (map[string]transportChange, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT file_id, change FROM pending_remote`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]transportChange{}
	for rows.Next() {
		var id, data string
		if err := rows.Scan(&id, &data); err != nil {
			return nil, err
		}
		var c transportChange
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			return nil, fmt.Errorf("pending change of %s: %w", id, err)
		}
		out[id] = c
	}
	return out, rows.Err()
}

// Quarantined is a server entry this device could not read.
type Quarantined struct {
	FileID    string
	Rev       int
	Reason    string
	CreatedAt time.Time
}

// Quarantine records a server entry that cannot be applied (undecryptable path).
func (d *DB) Quarantine(ctx context.Context, fileID string, rev int, reason string, now time.Time) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO quarantine (file_id, rev, reason, created_at) VALUES (?,?,?,?)
		ON CONFLICT(file_id) DO UPDATE SET rev=excluded.rev, reason=excluded.reason`,
		fileID, rev, reason, now.UnixNano())
	return err
}

// Quarantined lists the entries that could not be applied.
func (d *DB) Quarantined(ctx context.Context) ([]Quarantined, error) {
	rows, err := d.db.QueryContext(ctx, `SELECT file_id, rev, reason, created_at FROM quarantine ORDER BY file_id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Quarantined
	for rows.Next() {
		var q Quarantined
		var ts int64
		if err := rows.Scan(&q.FileID, &q.Rev, &q.Reason, &ts); err != nil {
			return nil, err
		}
		q.CreatedAt = time.Unix(0, ts)
		out = append(out, q)
	}
	return out, rows.Err()
}

// resetSQL empties the synchronization state (unlink, forgotten mount).
const resetSQL = `DELETE FROM sync_files; DELETE FROM outbox; DELETE FROM conflicts; DELETE FROM pending_remote; DELETE FROM quarantine; UPDATE sync_cursor SET last_seq = 0, last_id = ''`
