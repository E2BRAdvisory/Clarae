package db

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"
)

// The audit log is the record of what administrators did, and nothing in the service removes rows from
// it: a migration that dropped, truncated or deleted from audit_log would empty it for good on the next
// upgrade. This scan keeps that from entering the migrations by accident. Only the Up section is read:
// the Down section of 0001 drops the table, as every Down does.

// auditDestructive matches a statement that removes the table, its rows or one of its columns.
var auditDestructive = []*regexp.Regexp{
	regexp.MustCompile(`^drop\s+(table|schema)\b[^;]*\baudit_log\b`),
	regexp.MustCompile(`^truncate\b[^;]*\baudit_log\b`),
	regexp.MustCompile(`^delete\s+from\s+(only\s+)?([a-z_]+\.)?"?audit_log\b`),
	regexp.MustCompile(`^alter\s+table\s+(if\s+exists\s+)?(only\s+)?([a-z_]+\.)?"?audit_log\b[^;]*\bdrop\s+column\b`),
	// The table or the rows reached through a statement of a DO block or a function body.
	regexp.MustCompile(`\bdelete\s+from\s+(only\s+)?([a-z_]+\.)?"?audit_log\b`),
	regexp.MustCompile(`\btruncate\s+(table\s+)?(only\s+)?([a-z_]+\.)?"?audit_log\b`),
}

// upSection returns the part of a goose migration that runs on the way up.
func upSection(sql string) string {
	if i := strings.Index(sql, "-- +goose Down"); i >= 0 {
		sql = sql[:i]
	}
	return sql
}

var sqlLineComment = regexp.MustCompile(`--[^\n]*`)

// auditViolations returns the statements of sql (an Up section) that remove audit_log data.
func auditViolations(sql string) []string {
	sql = strings.ToLower(sqlLineComment.ReplaceAllString(sql, ""))
	var out []string
	for _, stmt := range strings.Split(sql, ";") {
		stmt = strings.Join(strings.Fields(stmt), " ")
		for _, re := range auditDestructive {
			if re.MatchString(stmt) {
				out = append(out, stmt)
				break
			}
		}
	}
	return out
}

func TestNoMigrationEmptiesTheAuditLog(t *testing.T) {
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		raw, err := fs.ReadFile(migrations, "migrations/"+e.Name())
		if err != nil {
			t.Fatal(err)
		}
		checked++
		for _, stmt := range auditViolations(upSection(string(raw))) {
			t.Errorf("%s would remove audit_log data on upgrade: %q", e.Name(), stmt)
		}
	}
	if checked < 16 {
		t.Fatalf("scanned %d migrations, expected the whole set", checked)
	}
}

// The scan itself: it catches the statements it exists for, whatever the case and the layout, and it
// leaves alone what does not remove data.
func TestAuditScanRecognisesDestructiveStatements(t *testing.T) {
	for name, tc := range map[string]struct {
		sql  string
		want bool
	}{
		"drop table":         {"DROP TABLE audit_log;", true},
		"drop if exists":     {"drop table if exists public.audit_log cascade;", true},
		"drop several":       {"DROP TABLE devices,\n  audit_log;", true},
		"truncate":           {"TRUNCATE audit_log;", true},
		"truncate table":     {"Truncate Table ONLY audit_log RESTART IDENTITY;", true},
		"delete":             {"DELETE FROM audit_log WHERE at < now() - interval '1 year';", true},
		"delete multi-line":  {"delete\n  from audit_log;", true},
		"drop column":        {"ALTER TABLE audit_log DROP COLUMN details;", true},
		"inside a DO block":  {"DO $$ BEGIN DELETE FROM audit_log; END $$;", true},
		"add an index":       {"CREATE INDEX audit_log_target_ix ON audit_log (target_id);", false},
		"drop an index":      {"DROP INDEX audit_log_action_ix;", false},
		"add a column":       {"ALTER TABLE audit_log ADD COLUMN request_id TEXT;", false},
		"another table":      {"DELETE FROM devices WHERE revoked_at IS NOT NULL;", false},
		"comment only":       {"-- DROP TABLE audit_log; is never done here\nSELECT 1;", false},
		"read":               {"SELECT count(*) FROM audit_log;", false},
		"drop another table": {"DROP TABLE export_jobs;", false},
	} {
		t.Run(name, func(t *testing.T) {
			if got := len(auditViolations(tc.sql)) > 0; got != tc.want {
				t.Fatalf("auditViolations(%q) = %v, want %v", tc.sql, got, tc.want)
			}
		})
	}
}

func TestUpSectionDropsTheDownPart(t *testing.T) {
	sql := "-- +goose Up\nCREATE TABLE audit_log (id int);\n-- +goose Down\nDROP TABLE audit_log;\n"
	if got := upSection(sql); strings.Contains(got, "DROP") || !strings.Contains(got, "CREATE TABLE") {
		t.Fatalf("upSection = %q", got)
	}
}
