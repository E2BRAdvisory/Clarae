//go:build integration

package integration

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func readZip(t *testing.T, resp *http.Response) map[string]string {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("not a valid ZIP (%d bytes): %v", len(body), err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

func exportFixture(t *testing.T) (*env, *client, string, map[string]string) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("My Vault: é", "shared")
	files := map[string]string{
		"Home.md":              "# Home\nwith [[Projects/plan]]",
		"Projects/plan.md":     "# plan",
		"Projects/deep/x.json": `{"a":1}`,
		"Attachments/blob.bin": strings.Repeat("\x00\x01", 1000),
		".nodus/editor.json":   `{"fontSize":14}`, // synced user settings travel with the vault
	}
	ada.seed(v, files)
	return e, ada, v, files
}

func TestExportStreamsTheVaultAsZip(t *testing.T) {
	e, ada, v, files := exportFixture(t)
	resp := ada.json(http.MethodGet, "/vaults/"+v+"/export.zip", nil)
	expect(t, resp, http.StatusOK)
	if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, `attachment; filename="My_Vault`) || !strings.HasSuffix(cd, `.zip"`) {
		t.Fatalf("content disposition %q", cd)
	}
	got := readZip(t, resp)
	if len(got) != len(files) {
		t.Fatalf("entries %d, want %d: %v", len(got), len(files), got)
	}
	for p, want := range files {
		if got[p] != want {
			t.Fatalf("%s: %q != %q", p, got[p], want)
		}
	}
	// Deleted files are not exported.
	ids := ada.seed(v, map[string]string{"Trash.md": "bye"})
	mustAccepted(t, ada.commit(v, del(ids["Trash.md"], 1))[0])
	if got := readZip(t, ada.json(http.MethodGet, "/vaults/"+v+"/export.zip", nil)); got["Trash.md"] != "" {
		t.Fatal("a deleted file was exported")
	}

	// Somebody else's vault does not exist for you; the export is audited.
	bob := e.user("bob")
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/export.zip", nil), http.StatusNotFound)
	var n int
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT COUNT(*) FROM audit_log WHERE action='vault.export' AND target_id=$1", v).Scan(&n); err != nil || n < 1 {
		t.Fatalf("audit entries %d %v", n, err)
	}
}

func TestExportRefusesPrivateVaults(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createPrivateVault("Secret")
	for _, p := range []struct{ method, path string }{{http.MethodGet, "/export.zip"}, {http.MethodPost, "/exports"}} {
		resp := ada.json(p.method, "/vaults/"+v+p.path, nil)
		expect(t, resp, http.StatusConflict)
		if code := problemCode(t, resp); code != "VAULT_ENCRYPTED" {
			t.Fatalf("%s: %s", p.path, code)
		}
	}
}

func TestExportJobProducesADownloadThatExpires(t *testing.T) {
	e, ada, v, files := exportFixture(t)
	resp := ada.json(http.MethodPost, "/vaults/"+v+"/exports", nil)
	expect(t, resp, http.StatusAccepted)
	job := decode[map[string]any](t, resp)
	id := job["id"].(string)
	if job["status"] != "queued" || job["download_url"] != nil {
		t.Fatalf("new job: %v", job)
	}
	if got := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id, nil)); got["status"] != "queued" {
		t.Fatalf("status %v", got["status"])
	}
	// Not ready yet: the download is not found.
	expect(t, ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id+"/download", nil), http.StatusNotFound)

	ctx := context.Background()
	if n, err := e.app.Exports.ProcessPending(ctx); err != nil || n < 1 {
		t.Fatalf("process: %d %v", n, err)
	}
	resp = ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id, nil)
	expect(t, resp, http.StatusOK)
	job = decode[map[string]any](t, resp)
	if job["status"] != "ready" || job["size"].(float64) <= 0 || job["expires_at"] == nil {
		t.Fatalf("finished job: %v", job)
	}
	url := job["download_url"].(string)
	if !strings.HasSuffix(url, "/vaults/"+v+"/exports/"+id+"/download") {
		t.Fatalf("download url %q", url)
	}
	dl := ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id+"/download", nil)
	expect(t, dl, http.StatusOK)
	got := readZip(t, dl)
	for p, want := range files {
		if got[p] != want {
			t.Fatalf("%s differs", p)
		}
	}
	// Another user cannot see the job.
	bob := e.user("bob")
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/exports/"+id, nil), http.StatusNotFound)
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/exports/"+id+"/download", nil), http.StatusNotFound)

	// After 24 hours the archive is gone.
	e.app.Exports.SetClock(func() time.Time { return time.Now().Add(25 * time.Hour) })
	t.Cleanup(func() { e.app.Exports.SetClock(time.Now) })
	if err := e.app.Exports.Expire(ctx); err != nil {
		t.Fatal(err)
	}
	if got := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id, nil)); got["status"] != "expired" || got["download_url"] != nil {
		t.Fatalf("expired job: %v", got)
	}
	expect(t, ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id+"/download", nil), http.StatusNotFound)
	if _, err := e.app.ExportStore.Size(ctx, "exports/"+id+".zip"); err == nil {
		t.Fatal("the archive was not deleted from the store")
	}
}

func TestExportJobFailureIsRecorded(t *testing.T) {
	e, ada, v, _ := exportFixture(t)
	resp := ada.json(http.MethodPost, "/vaults/"+v+"/exports", nil)
	expect(t, resp, http.StatusAccepted)
	id := decode[map[string]any](t, resp)["id"].(string)
	// Corrupt the store: the blob of a file disappears.
	var hash string
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT blob_hash FROM files WHERE vault_id=$1 AND path='Home.md'", v).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if err := e.app.Store.Delete(context.Background(), "blobs/"+hash[:2]+"/"+hash); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.Exports.ProcessPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id, nil))
	if got["status"] != "failed" || got["error"] == nil || got["download_url"] != nil {
		t.Fatalf("failed job: %v", got)
	}
}
