//go:build integration

package integration

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"clarae/services/cloud/internal/db"
)

// registerDevice posts /me/devices and returns the device with its HTTP status.
func (c *client) registerDevice(name, platform string, headers map[string]string) (map[string]any, int) {
	c.e.t.Helper()
	body, err := json.Marshal(map[string]any{"name": name, "platform": platform, "app_version": "1.7.2"})
	if err != nil {
		c.e.t.Fatal(err)
	}
	resp := c.raw(http.MethodPost, "/me/devices", "application/json", body, headers)
	status := resp.StatusCode
	expect(c.e.t, resp, http.StatusCreated)
	return decode[map[string]any](c.e.t, resp), status
}

// ADR-0057: a desktop device is identified by its host name, so logging out and in again gives back the same
// device instead of one more row.
func TestDesktopDeviceIsIdentifiedByItsHostname(t *testing.T) {
	e := newEnv(t)
	c := e.user("hostname-dev")

	first, status := c.registerDevice("Studio-Mac", "macos", nil)
	if status != http.StatusCreated {
		t.Fatalf("status %d", status)
	}
	id := first["id"].(string)
	expect(t, c.json(http.MethodDelete, "/me/devices/"+id, nil), http.StatusNoContent)
	if ids := deviceIDs(t, c); slices.Contains(ids, id) {
		t.Fatalf("the revoked device is still listed: %v", ids)
	}

	// The next login registers the same host: same device, reactivated, no duplicate. The comparison ignores the
	// case and the spaces around the name; the stored name is the latest one.
	again, status := c.registerDevice(" studio-mac ", "macos", map[string]string{"Idempotency-Key": "login-2"})
	if status != http.StatusCreated || again["id"] != id {
		t.Fatalf("re-registration: status %d, id %v, want %s", status, again["id"], id)
	}
	if again["name"] != " studio-mac " {
		t.Fatalf("name = %v", again["name"])
	}
	if n := e.count("SELECT COUNT(*) FROM devices WHERE user_id=$1 AND platform='macos'", c.uid()); n != 1 {
		t.Fatalf("%d macos devices, want 1", n)
	}
	// The macOS device and the Linux one e.user registered.
	if ids := deviceIDs(t, c); len(ids) != 2 || !slices.Contains(ids, id) {
		t.Fatalf("ListDevices = %v", ids)
	}

	// The retry of that login (same Idempotency-Key) and a later login with another key resolve to the one row.
	replay, _ := c.registerDevice("studio-mac", "macos", map[string]string{"Idempotency-Key": "login-2"})
	third, _ := c.registerDevice("STUDIO-MAC", "macos", map[string]string{"Idempotency-Key": "login-3"})
	if replay["id"] != id || third["id"] != id {
		t.Fatalf("replay %v, third login %v, want %s", replay["id"], third["id"], id)
	}
	if n := e.count("SELECT COUNT(*) FROM devices WHERE user_id=$1 AND platform='macos'", c.uid()); n != 1 {
		t.Fatalf("%d macos devices, want 1", n)
	}

	// The same host name on another platform is another device.
	other, _ := c.registerDevice("Studio-Mac", "linux", nil)
	if other["id"] == id {
		t.Fatal("a linux device took the id of the macOS one")
	}
	if n := e.count("SELECT COUNT(*) FROM devices WHERE user_id=$1 AND lower(name)='studio-mac'", c.uid()); n != 2 {
		t.Fatalf("%d devices named studio-mac, want 2", n)
	}

	// Another user with the same host name has a device of their own.
	d := e.user("hostname-dev-2")
	mine, _ := d.registerDevice("Studio-Mac", "macos", nil)
	if mine["id"] == id {
		t.Fatal("two users share a device")
	}

	// A web device is never deduplicated.
	w1, _ := c.registerDevice("Firefox", "web", nil)
	w2, _ := c.registerDevice("Firefox", "web", nil)
	if w1["id"] == w2["id"] {
		t.Fatal("the web registrations were merged")
	}
}

// The reactivated device is the one the user's revisions point to: a commit refused after the revocation works again
// with the same id once the host registers again.
func TestReRegisteredDeviceCanCommitAgain(t *testing.T) {
	e := newEnv(t)
	c := e.user("hostname-commit")
	vault := c.createVault("V", "shared")
	h := c.putBlob(vault, []byte("body"))

	dev, _ := c.registerDevice("Workstation", "windows", nil)
	c.deviceID = dev["id"].(string)
	mustAccepted(t, c.commit(vault, create(newID(), "a.md", h))[0])

	expect(t, c.json(http.MethodDelete, "/me/devices/"+c.deviceID, nil), http.StatusNoContent)
	resp := c.json(http.MethodPost, "/vaults/"+vault+"/commit", map[string]any{"device_id": c.deviceID, "ops": []map[string]any{create(newID(), "b.md", h)}})
	expect(t, resp, http.StatusForbidden)

	back, _ := c.registerDevice("workstation", "windows", nil)
	if back["id"] != c.deviceID {
		t.Fatalf("id %v, want %s", back["id"], c.deviceID)
	}
	mustAccepted(t, c.commit(vault, create(newID(), "b.md", h))[0])
}

func deviceIDs(t *testing.T, c *client) []string {
	t.Helper()
	resp := c.json(http.MethodGet, "/me/devices", nil)
	var out []string
	for _, d := range decode[map[string][]map[string]any](t, resp)["items"] {
		out = append(out, d["id"].(string))
	}
	return out
}

// latestMigrationVersion is the highest version among the files of internal/db/migrations.
func latestMigrationVersion(t *testing.T) int64 {
	t.Helper()
	entries, err := os.ReadDir("../../internal/db/migrations")
	if err != nil {
		t.Fatal(err)
	}
	var latest int64
	for _, en := range entries {
		num, _, ok := strings.Cut(en.Name(), "_")
		if !ok {
			continue
		}
		v, err := strconv.ParseInt(num, 10, 64)
		if err != nil {
			t.Fatalf("migration %s: %v", en.Name(), err)
		}
		latest = max(latest, v)
	}
	return latest
}

// migrateTo applies the migrations of internal/db/migrations to the database at url up to version (0: all of them).
func migrateTo(t *testing.T, url string, version int64) {
	t.Helper()
	ctx := context.Background()
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB := stdlib.OpenDB(*cfg)
	defer func(d *sql.DB) { _ = d.Close() }(sqlDB)
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, os.DirFS("../../internal/db/migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if version == 0 {
		_, err = p.Up(ctx)
	} else {
		_, err = p.UpTo(ctx, version)
	}
	if err != nil {
		t.Fatalf("migrate to %d: %v", version, err)
	}
}

// Migration 0016 over a database whose devices were duplicated by the logouts of 1.x: one active device per host stays,
// the others are revoked and lose the host name, no row is deleted, and the unique index can be created.
func TestDeviceHostnameMigrationDeduplicates(t *testing.T) {
	ctx := context.Background()
	url := freshDatabase(t, "device_hostname")
	migrateTo(t, url, 15)
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()

	user := uuid.New()
	if _, err := conn.Exec(ctx, `INSERT INTO users (id, keycloak_sub, username, email) VALUES ($1, 'sub-migr', 'migr', 'migr@clarae.local')`, user); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	day := 24 * time.Hour
	type row struct {
		name, platform string
		seen           *time.Time
		created        time.Time
		revoked        *time.Time
	}
	at := func(d time.Duration) *time.Time { v := now.Add(-d); return &v }
	rows := map[string]row{
		// Three active rows for one Linux host: the most recent activity (B) wins whatever the case of the name.
		"A": {"Studio", "linux", at(3 * day), now.Add(-30 * day), nil},
		"B": {"studio", "linux", at(1 * day), now.Add(-20 * day), nil},
		"C": {"STUDIO ", "linux", nil, now.Add(-1 * day), nil},
		// The same name on macOS: only revoked rows, the most recent one keeps the host name.
		"R1": {"Studio", "macos", at(9 * day), now.Add(-40 * day), at(8 * day)},
		"R2": {"Studio", "macos", at(5 * day), now.Add(-35 * day), at(4 * day)},
		// An active row beats a revoked one with more recent activity.
		"M1": {"Mini", "windows", at(1 * day), now.Add(-30 * day), at(12 * time.Hour)},
		"M2": {"mini", "windows", at(6 * day), now.Add(-20 * day), nil},
		// Web devices and blank names have no host name.
		"W1": {"Studio", "web", at(1 * day), now.Add(-3 * day), nil},
		"W2": {"Studio", "web", at(1 * day), now.Add(-2 * day), nil},
		"X":  {"  ", "linux", nil, now.Add(-2 * day), nil},
	}
	ids := map[string]uuid.UUID{}
	for k, r := range rows {
		id := uuid.New()
		ids[k] = id
		if _, err := conn.Exec(ctx, `INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			id, user, r.name, r.platform, r.created, r.seen, r.revoked); err != nil {
			t.Fatal(err)
		}
	}

	migrateTo(t, url, 0)

	type result struct {
		hostname *string
		revoked  *time.Time
	}
	get := func(k string) result {
		var out result
		if err := conn.QueryRow(ctx, `SELECT hostname, revoked_at FROM devices WHERE id=$1`, ids[k]).Scan(&out.hostname, &out.revoked); err != nil {
			t.Fatalf("%s: %v", k, err)
		}
		return out
	}
	wantHost := map[string]string{"B": "studio", "R2": "studio", "M2": "mini"}
	for k := range rows {
		got := get(k)
		if want, ok := wantHost[k]; ok {
			if got.hostname == nil || *got.hostname != want {
				t.Errorf("%s: hostname %v, want %q", k, got.hostname, want)
			}
		} else if got.hostname != nil {
			t.Errorf("%s: hostname %q, want none", k, *got.hostname)
		}
	}
	// The duplicates of the Linux host were revoked now; the rows that were revoked keep their date.
	for _, k := range []string{"A", "C"} {
		if get(k).revoked == nil {
			t.Errorf("%s was not revoked", k)
		}
	}
	for _, k := range []string{"B", "M2", "W1", "W2", "X"} {
		if get(k).revoked != nil {
			t.Errorf("%s was revoked", k)
		}
	}
	for _, k := range []string{"M1", "R1", "R2"} {
		if r := get(k); r.revoked == nil || !r.revoked.Equal(*rows[k].revoked) {
			t.Errorf("%s revoked_at = %v, want %v", k, r.revoked, rows[k].revoked)
		}
	}
	var total, active int
	if err := conn.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE revoked_at IS NULL AND platform='linux' AND lower(btrim(name))='studio') FROM devices WHERE user_id=$1`, user).Scan(&total, &active); err != nil {
		t.Fatal(err)
	}
	if total != len(rows) || active != 1 {
		t.Fatalf("%d rows (want %d), %d active linux studio (want 1)", total, len(rows), active)
	}

	// The unique index exists and enforces the identity.
	var indexed bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='devices' AND indexname='devices_hostname_uq')`).Scan(&indexed); err != nil || !indexed {
		t.Fatalf("devices_hostname_uq missing (%v)", err)
	}
	_, err = conn.Exec(ctx, `INSERT INTO devices (id, user_id, name, platform, hostname) VALUES ($1,$2,'studio','linux','studio')`, uuid.New(), user)
	if !db.IsUniqueViolation(err) {
		t.Fatalf("duplicate host name: %v, want a unique violation", err)
	}
}

// The audit log is the record of what administrators did: migrating a database from the previous version to the latest
// keeps every row (the log is never emptied by an upgrade).
func TestMigrationKeepsTheAuditLog(t *testing.T) {
	ctx := context.Background()
	url := freshDatabase(t, "audit_keep")
	migrateTo(t, url, latestMigrationVersion(t)-1)
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	first := time.Now().UTC().Add(-90 * 24 * time.Hour).Truncate(time.Second)
	for i := range 5 {
		if _, err := conn.Exec(ctx, `INSERT INTO audit_log (at, action, target_type, target_id) VALUES ($1, 'user.role_changed', 'user', $2)`, first.Add(time.Duration(i)*time.Hour), uuid.NewString()); err != nil {
			t.Fatal(err)
		}
	}
	migrateTo(t, url, 0)
	var n int
	var minAt time.Time
	if err := conn.QueryRow(ctx, `SELECT count(*), min(at) FROM audit_log`).Scan(&n, &minAt); err != nil {
		t.Fatal(err)
	}
	if n != 5 || !minAt.Equal(first) {
		t.Fatalf("audit_log has %d rows from %v, want 5 from %v", n, minAt, first)
	}
}
