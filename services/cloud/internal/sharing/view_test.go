package sharing

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/sharing/sharingdb"
)

func grant(ptype, perm, status string) sharingdb.ShareGrant {
	return sharingdb.ShareGrant{ID: uuid.New(), PrincipalType: ptype, Permission: perm, Status: status}
}

// share-declined-status-never-set: the status is computed by precedence
// (accepted, then pending, then declined), so a declined invitation is reported.
func TestMyStatusPrecedence(t *testing.T) {
	cases := []struct {
		grants []sharingdb.ShareGrant
		want   string
	}{
		{[]sharingdb.ShareGrant{grant("user", "viewer", "declined")}, "declined"},
		{[]sharingdb.ShareGrant{grant("user", "viewer", "pending")}, "pending"},
		{[]sharingdb.ShareGrant{grant("user", "viewer", "declined"), grant("group", "editor", "pending")}, "pending"},
		{[]sharingdb.ShareGrant{grant("user", "viewer", "declined"), grant("group", "editor", "accepted")}, "accepted"},
		{[]sharingdb.ShareGrant{grant("group", "editor", "pending"), grant("user", "viewer", "accepted")}, "accepted"},
	}
	for i, c := range cases {
		if got := myStatus(c.grants); got != c.want {
			t.Errorf("case %d: %q, want %q", i, got, c.want)
		}
	}
}

func TestBuildView(t *testing.T) {
	owner, viewer := uuid.New(), uuid.New()
	sh := sharingdb.Share{ID: uuid.New(), CreatedAt: time.Now()}

	v, ok := buildView(sh, "V", owner, "ada", owner, nil)
	if !ok || !v.IsOwner || v.MyStatus != "" {
		t.Fatalf("owner: %+v %v", v, ok)
	}
	if _, ok := buildView(sh, "V", owner, "ada", viewer, nil); ok {
		t.Fatal("a viewer without grants sees nothing")
	}
	v, _ = buildView(sh, "V", owner, "ada", viewer, []sharingdb.ShareGrant{grant("user", "editor", "declined")})
	if v.MyStatus != "declined" || v.MyPermission != access.None || v.canManage() {
		t.Fatalf("declined: %+v", v)
	}
	// A declined direct grant next to a pending group grant: the offer shown is the group's.
	v, _ = buildView(sh, "V", owner, "ada", viewer, []sharingdb.ShareGrant{grant("user", "manager", "declined"), grant("group", "viewer", "pending")})
	if v.MyStatus != "pending" || v.MyPermission != access.Viewer {
		t.Fatalf("pending group offer: %+v", v)
	}
	revoked := sh
	revoked.RevokedAt = &sh.CreatedAt
	if _, ok := buildView(revoked, "V", owner, "ada", viewer, []sharingdb.ShareGrant{grant("user", "viewer", "accepted")}); ok {
		t.Fatal("a revoked share is invisible to recipients")
	}
}
