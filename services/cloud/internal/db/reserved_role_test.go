package db

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// memberRoleCondition finds member_role used to decide something: in a
// condition, a join or a CASE, rather than stored or listed.
var (
	memberRoleCondition = regexp.MustCompile(`(?is)\b(?:WHERE|AND|OR|ON|WHEN|HAVING)\b[^;]*?\bmember_role\b`)
	// onConflict is the upsert tail, where SET member_role = EXCLUDED.member_role stores the role.
	onConflict = regexp.MustCompile(`(?is)ON\s+CONFLICT.*`)
)

// TestGroupManagerRoleIsReserved pins ADR-0041 §9: the manager role inside a
// group is stored and shown (groups.sql writes and lists it, the admin console
// and /me/groups show it) but no query authorizes anything with it. Sharing
// resolves memberships from group_members without looking at the role, so a
// group manager has exactly the access of any other member. A query that starts
// reading the role in a condition, or from another module, fails here until the
// spec gives the role a capability.
func TestGroupManagerRoleIsReserved(t *testing.T) {
	files, err := filepath.Glob("queries/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("no queries: %v", err)
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		sql := sqlComment.ReplaceAllString(string(raw), "")
		if !strings.Contains(sql, "member_role") {
			continue
		}
		if filepath.Base(f) != "groups.sql" {
			t.Errorf("%s reads member_role: the group manager role is reserved (ADR-0041 §9)", f)
			continue
		}
		for _, stmt := range strings.Split(sql, ";") {
			if memberRoleCondition.MatchString(onConflict.ReplaceAllString(stmt, "")) {
				t.Errorf("%s decides on member_role in %q: the group manager role is reserved (ADR-0041 §9)", f, strings.TrimSpace(stmt))
			}
		}
	}
}
