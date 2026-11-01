package db

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// owners maps each module to the tables it owns (spec §4.3, ADR-0033). A
// module's query file (queries/<module>.sql) may read and write only these,
// plus its declared exceptions. Co-owners: revisions shares the changelog
// (files, file_revisions) with sync; quota keeps the accounting columns of
// users (used_bytes).
var owners = map[string][]string{
	"admin":          {"storage_snapshots"},
	"audit":          {"audit_log"},
	"blobs":          {"blobs", "vault_blobs", "uploads"},
	"configprofiles": {"config_profiles", "config_profile_versions", "config_assignments"},
	"export":         {"export_jobs"},
	"groups":         {"groups", "group_members"},
	"jobs":           {},
	"notify":         {},
	"privacy":        {},
	"quota":          {"users"},
	"revisions":      {"files", "file_revisions"},
	"settings":       {"settings"},
	"sharing":        {"shares", "share_grants"},
	"sync":           {"files", "file_revisions"},
	"users":          {"users", "devices"},
	"vaults":         {"vaults", "vault_key_envelopes"},
}

// readExceptions are the foreign tables a module may read, each with the
// reason recorded in ADR-0033. Every other access goes through the owner's
// exported functions.
var readExceptions = map[string][]string{
	// The administration console shows aggregates across the whole service.
	"admin": {"audit_log", "devices", "group_members", "groups", "users", "vaults"},
	// Which blobs are still referenced, and which files a shared reader may see.
	"blobs": {"file_revisions", "files"},
	// The profiles of a user follow their group memberships.
	"configprofiles": {"group_members"},
	// Member names in the member list.
	"groups": {"users"},
	// Maintenance reconciles counters and purges across the data plane; the
	// tombstone purge keeps files that a file share still points at.
	"jobs": {"file_revisions", "shares"},
	// Fan-out of events: notify cannot depend on the modules that publish through it.
	"notify": {"group_members", "share_grants", "shares", "vaults"},
	// The personal data export collects everything about one account (GDPR art. 15).
	"privacy": {"file_revisions", "shares", "vault_key_envelopes", "vaults"},
	// Authorization and share roots look at files and memberships; sync depends on
	// sharing, so sharing cannot call sync.
	"sharing": {"files", "group_members", "groups", "users", "vaults"},
	// The manifest of a vault (GET /tree); sync depends on vaults.
	"vaults": {"files"},
}

// writeExceptions are the foreign tables a module may change (ADR-0033).
var writeExceptions = map[string][]string{
	// Maintenance: blob collection, changelog compaction, purges, counter reconciliation.
	"jobs": {"blobs", "files", "users", "vaults"},
	// Account deletion (GDPR art. 17) erases the account's rows everywhere at once.
	"privacy": {"audit_log", "devices", "export_jobs", "group_members", "share_grants", "uploads", "users"},
}

var (
	createTable = regexp.MustCompile(`(?i)CREATE TABLE (?:IF NOT EXISTS )?(\w+)`)
	// writeStmt names the table a statement changes; a schema prefix
	// (public.users) and ONLY are skipped so they cannot hide the table.
	writeStmt  = regexp.MustCompile(`(?i)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO)\s+(?:ONLY\s+)?(?:\w+\.)?(\w+)`)
	sqlComment = regexp.MustCompile(`--[^\n]*`)
	// rawSQL finds a table used by SQL written in a Go string literal. The
	// keywords are matched in upper case only, as the code writes SQL, so
	// prose in messages ("cannot update users") does not count.
	rawSQL = regexp.MustCompile(`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|FROM|JOIN)\s+(?:ONLY\s+)?(?:\w+\.)?(\w+)`)
)

func schemaTables(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("migrations/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations: %v", err)
	}
	var out []string
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range createTable.FindAllStringSubmatch(string(raw), -1) {
			out = append(out, strings.ToLower(m[1]))
		}
	}
	return out
}

// TestModulesTouchOnlyTheirTables checks every query file against the table
// ownership: a new query on a foreign table fails here until it moves to the
// owner (or the exception is argued in an ADR and added above).
func TestModulesTouchOnlyTheirTables(t *testing.T) {
	tables := schemaTables(t)
	files, err := filepath.Glob("queries/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range files {
		mod := strings.TrimSuffix(filepath.Base(f), ".sql")
		seen[mod] = true
		owned, ok := owners[mod]
		if !ok {
			t.Errorf("%s: module %q has no entry in the ownership map", f, mod)
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		sql := sqlComment.ReplaceAllString(string(raw), "")
		written := map[string]bool{}
		for _, m := range writeStmt.FindAllStringSubmatch(sql, -1) {
			if name := strings.ToLower(m[1]); slices.Contains(tables, name) {
				written[name] = true
			}
		}
		for name := range written {
			if !slices.Contains(owned, name) && !slices.Contains(writeExceptions[mod], name) {
				t.Errorf("%s writes %s, owned by another module: use the owner's exported functions", f, name)
			}
		}
		for _, name := range tables {
			if written[name] || !regexp.MustCompile(`\b`+name+`\b`).MatchString(sql) {
				continue
			}
			if !slices.Contains(owned, name) && !slices.Contains(readExceptions[mod], name) && !slices.Contains(writeExceptions[mod], name) {
				t.Errorf("%s reads %s, owned by another module: use the owner's exported functions", f, name)
			}
		}
	}
	for mod := range owners {
		if !seen[mod] {
			t.Errorf("module %q is in the ownership map but has no queries/%s.sql", mod, mod)
		}
	}
}

// TestEveryTableHasAnOwner keeps the map complete when a migration adds a table.
func TestEveryTableHasAnOwner(t *testing.T) {
	var orphans []string
	for _, name := range schemaTables(t) {
		owned := false
		for _, ts := range owners {
			owned = owned || slices.Contains(ts, name)
		}
		if !owned {
			orphans = append(orphans, name)
		}
	}
	sort.Strings(orphans)
	if len(orphans) > 0 {
		t.Fatalf("tables without an owning module: %v", orphans)
	}
}

// TestWriteStmtSeesThroughSchemaAndVariants guards the checker itself.
func TestWriteStmtSeesThroughSchemaAndVariants(t *testing.T) {
	for stmt, want := range map[string]string{
		"UPDATE public.users SET x = 1":     "users",
		"DELETE FROM ONLY share_grants":     "share_grants",
		"insert into public.devices values": "devices",
		"TRUNCATE TABLE audit_log":          "audit_log",
		"TRUNCATE vaults":                   "vaults",
		"MERGE INTO files f USING x":        "files",
	} {
		m := writeStmt.FindStringSubmatch(stmt)
		if m == nil || strings.ToLower(m[1]) != want {
			t.Errorf("%q: got %v, want table %s", stmt, m, want)
		}
	}
}

// TestNoRawSQLOnTablesOutsideQueryFiles keeps every table access in the
// checked query files: SQL in a Go string literal (tx.Exec(ctx, "UPDATE
// users ...")) would bypass both sqlc and the ownership check above. The
// generated packages (*db) and tests are exempt; statements that touch no
// table (pg_notify, advisory locks, LISTEN) are fine.
func TestNoRawSQLOnTablesOutsideQueryFiles(t *testing.T) {
	tables := schemaTables(t)
	fset := token.NewFileSet()
	for _, root := range []string{"..", "../../cmd"} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				// The sqlc output, and this package (migrations, the runner).
				if strings.HasSuffix(d.Name(), "db") && path != root {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
			if err != nil {
				return err
			}
			ast.Inspect(f, func(n ast.Node) bool {
				lit, ok := n.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				v, err := strconv.Unquote(lit.Value)
				if err != nil {
					return true
				}
				for _, m := range rawSQL.FindAllStringSubmatch(v, -1) {
					if slices.Contains(tables, strings.ToLower(m[1])) {
						t.Errorf("%s: SQL on table %s in Go code: move it to a queries/<module>.sql file", fset.Position(lit.Pos()), m[1])
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
