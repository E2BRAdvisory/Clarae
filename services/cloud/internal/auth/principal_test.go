package auth

import "testing"

func TestRoleFromRealmRoles(t *testing.T) {
	for _, tc := range []struct {
		name       string
		roles      []string
		adminRoles []string
		want       Role
	}{
		{"new admin role, default list", []string{"clarae-user", "clarae-admin"}, DefaultAdminRoles, RoleAdmin},
		// A realm made for 1.x only has the old role: it must keep opening the console.
		{"old admin role, default list", []string{"memobrain-user", "memobrain-admin"}, DefaultAdminRoles, RoleAdmin},
		{"user roles only", []string{"clarae-user", "memobrain-user", "offline_access"}, DefaultAdminRoles, RoleUser},
		{"no roles", nil, DefaultAdminRoles, RoleUser},
		{"explicit list replaces the default", []string{"clarae-admin"}, []string{"ops"}, RoleUser},
		{"explicit list match", []string{"ops"}, []string{"ops"}, RoleAdmin},
		{"empty list grants nothing", []string{"clarae-admin"}, nil, RoleUser},
		{"match is exact", []string{"clarae-administrator", "Clarae-Admin"}, DefaultAdminRoles, RoleUser},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := RoleFromRealmRoles(tc.roles, tc.adminRoles); got != tc.want {
				t.Fatalf("RoleFromRealmRoles(%v, %v) = %q, want %q", tc.roles, tc.adminRoles, got, tc.want)
			}
		})
	}
}
