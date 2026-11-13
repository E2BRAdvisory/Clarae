//go:build integration

package integration

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"clarae/services/cloud/internal/db"
)

// unindexedReferences are the tables whose rows are never deleted, so the
// foreign keys pointing at them need no index for the referential checks:
// users stay as tombstones after the account purge (ADR-0021).
var unindexedReferences = []string{"users"}

// Every foreign key needs an index on the referencing columns: deleting a
// referenced row (a file, a device, a vault) checks or cascades into the
// referencing table, and without an index that is a scan of the whole table
// per deleted row (M12, missing-indexes). A partial index serves when its only
// predicate is "<column> IS NOT NULL" of a single-column key.
func TestEveryForeignKeyHasAnIndex(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	type index struct {
		cols []string
		pred string
	}
	indexes := map[string][]index{}
	rows, err := d.Pool.Query(ctx, `
SELECT t.relname,
       array(SELECT COALESCE(a.attname, '')
             FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
             LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             ORDER BY k.ord)::text[],
       COALESCE(pg_get_expr(i.indpred, i.indrelid), '')
FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
WHERE t.relnamespace = 'public'::regnamespace`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var table string
		var ix index
		if err := rows.Scan(&table, &ix.cols, &ix.pred); err != nil {
			t.Fatal(err)
		}
		indexes[table] = append(indexes[table], ix)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	rows, err = d.Pool.Query(ctx, `
SELECT c.conname, t.relname, r.relname,
       array(SELECT a.attname
             FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             ORDER BY k.ord)::text[]
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class r ON r.oid = c.confrelid
WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
ORDER BY t.relname, c.conname`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	checked := 0
	for rows.Next() {
		var name, table, referenced string
		var cols []string
		if err := rows.Scan(&name, &table, &referenced, &cols); err != nil {
			t.Fatal(err)
		}
		checked++
		if slices.Contains(unindexedReferences, referenced) {
			continue
		}
		covered := slices.ContainsFunc(indexes[table], func(ix index) bool {
			if len(ix.cols) < len(cols) {
				return false
			}
			lead := slices.Clone(ix.cols[:len(cols)])
			want := slices.Clone(cols)
			slices.Sort(lead)
			slices.Sort(want)
			if !slices.Equal(lead, want) {
				return false
			}
			return ix.pred == "" || (len(cols) == 1 && ix.pred == fmt.Sprintf("(%s IS NOT NULL)", cols[0]))
		})
		if !covered {
			t.Errorf("foreign key %s: no index on %s %v (references %s)", name, table, cols, referenced)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if checked < 10 {
		t.Fatalf("only %d foreign keys found: the catalog query is wrong", checked)
	}
}
