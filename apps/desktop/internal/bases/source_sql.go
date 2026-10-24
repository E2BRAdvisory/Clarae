package bases

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// LoadNotes reads every indexed file with its properties, tags and links from
// the vault index (index.db). Files are ordered by path. ctime is not indexed:
// it equals mtime.
func LoadNotes(ctx context.Context, db *sql.DB) ([]*Note, error) {
	rows, err := db.QueryContext(ctx, `SELECT path, mtime_ns, size, hash FROM files WHERE kind != 'config' ORDER BY path`)
	if err != nil {
		return nil, err
	}
	var notes []*Note
	byPath := map[string]*Note{}
	for rows.Next() {
		n := &Note{}
		var mtime int64
		if err := rows.Scan(&n.Path, &mtime, &n.Size, &n.Hash); err != nil {
			_ = rows.Close()
			return nil, err
		}
		n.MTime = time.Unix(0, mtime)
		n.CTime = n.MTime
		n.Prepare()
		notes = append(notes, n)
		byPath[n.Path] = n
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	props, err := db.QueryContext(ctx, `SELECT path, key, kind, value FROM properties`)
	if err != nil {
		return nil, err
	}
	for props.Next() {
		var path, key, kind, val string
		if err := props.Scan(&path, &key, &kind, &val); err != nil {
			_ = props.Close()
			return nil, err
		}
		n := byPath[path]
		if n == nil {
			continue
		}
		var raw any
		if json.Unmarshal([]byte(val), &raw) != nil {
			raw = val
		}
		n.Props = append(n.Props, PropEntry{Key: key, Kind: kind, Value: FromJSON(raw, kind)})
	}
	if err := props.Close(); err != nil {
		return nil, err
	}

	tags, err := db.QueryContext(ctx, `SELECT path, name FROM tags`)
	if err != nil {
		return nil, err
	}
	for tags.Next() {
		var path, name string
		if err := tags.Scan(&path, &name); err != nil {
			_ = tags.Close()
			return nil, err
		}
		if n := byPath[path]; n != nil {
			n.Tags = appendUnique(n.Tags, "#"+name)
		}
	}
	if err := tags.Close(); err != nil {
		return nil, err
	}

	links, err := db.QueryContext(ctx, `SELECT path, COALESCE(target_resolved, target_raw) FROM links WHERE kind != 'external'`)
	if err != nil {
		return nil, err
	}
	for links.Next() {
		var path, target string
		if err := links.Scan(&path, &target); err != nil {
			_ = links.Close()
			return nil, err
		}
		if n := byPath[path]; n != nil {
			n.Links = appendUnique(n.Links, target)
		}
	}
	if err := links.Close(); err != nil {
		return nil, err
	}
	return notes, nil
}

func appendUnique(list []string, s string) []string {
	for _, e := range list {
		if e == s {
			return list
		}
	}
	return append(list, s)
}
