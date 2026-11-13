//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"clarae/shared/syncproto"
)

func TestVaultLifecycle(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")

	id := ada.createVault("Notes", "shared")
	if resp := ada.json(http.MethodPost, "/vaults", map[string]any{"name": "Notes", "kind": "shared"}); resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate name: %d", resp.StatusCode)
	} else if p := decode[syncproto.Problem](t, resp); p.Code != syncproto.CodeNameInUse {
		t.Fatalf("code %s", p.Code)
	}
	resp := ada.json(http.MethodGet, "/vaults", nil)
	list := decode[struct {
		Items  []map[string]any `json:"items"`
		Mounts []any            `json:"mounts"`
	}](t, resp)
	if len(list.Items) != 1 || list.Items[0]["kind"] != "shared" || len(list.Mounts) != 0 {
		t.Fatalf("list: %+v", list)
	}

	// Another user cannot see, read or write it, and learns nothing about it.
	for _, req := range []struct{ m, p string }{{"GET", "/vaults/" + id}, {"GET", "/vaults/" + id + "/tree"}, {"GET", "/vaults/" + id + "/changes?since=0"}, {"DELETE", "/vaults/" + id}} {
		if r := bob.json(req.m, req.p, nil); r.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s as other user: %d", req.m, req.p, r.StatusCode)
		}
	}

	resp = ada.json(http.MethodPatch, "/vaults/"+id, map[string]any{"name": "Renamed"})
	expect(t, resp, http.StatusOK)
	if decode[map[string]any](t, resp)["name"] != "Renamed" {
		t.Fatal("rename not applied")
	}

	expect(t, ada.json(http.MethodDelete, "/vaults/"+id, nil), http.StatusNoContent)
	expect(t, ada.json(http.MethodGet, "/vaults/"+id, nil), http.StatusNotFound)
	// The name is free while deleted...
	other := ada.createVault("Renamed", "shared")
	// ...so restoring conflicts until the other one moves away.
	if r := ada.json(http.MethodPost, "/vaults/"+id+":restore", nil); r.StatusCode != http.StatusConflict {
		t.Fatalf("restore conflict: %d", r.StatusCode)
	}
	expect(t, ada.json(http.MethodPatch, "/vaults/"+other, map[string]any{"name": "Other"}), http.StatusOK)
	expect(t, ada.json(http.MethodPost, "/vaults/"+id+":restore", nil), http.StatusOK)
	expect(t, ada.json(http.MethodGet, "/vaults/"+id, nil), http.StatusOK)
	if r := ada.json(http.MethodPost, "/vaults/"+id+":restore", nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("restoring a live vault: %d", r.StatusCode)
	}
	if r := ada.json(http.MethodPatch, "/vaults/"+id, map[string]any{"name": "  "}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank name: %d", r.StatusCode)
	}
}

func TestPrivateVaultKeyEnvelopes(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")

	if r := ada.json(http.MethodPost, "/vaults", map[string]any{"name": "Diary", "kind": "private"}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("private without envelopes: %d", r.StatusCode)
	}
	if r := ada.json(http.MethodPost, "/vaults", map[string]any{"name": "Diary", "kind": "private", "key_envelopes": envelopes()[:1]}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("private with one envelope: %d", r.StatusCode)
	}
	weak := envelopes()
	weak[0]["kdf"].(map[string]any)["m_kib"] = 1024
	if r := ada.json(http.MethodPost, "/vaults", map[string]any{"name": "Diary", "kind": "private", "key_envelopes": weak}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("weak KDF accepted: %d", r.StatusCode)
	}
	short := envelopes()
	short[1]["wrapped_vmk"] = base64.StdEncoding.EncodeToString([]byte("short"))
	if r := ada.json(http.MethodPost, "/vaults", map[string]any{"name": "Diary", "kind": "private", "key_envelopes": short}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("short wrapped key accepted: %d", r.StatusCode)
	}
	if r := ada.json(http.MethodPost, "/vaults", map[string]any{"name": "Shared", "kind": "shared", "key_envelopes": envelopes()}); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("shared vault with envelopes: %d", r.StatusCode)
	}

	id := ada.createPrivateVault("Diary")
	resp := ada.json(http.MethodGet, "/vaults/"+id+"/key-envelopes", nil)
	expect(t, resp, http.StatusOK)
	got := decode[struct{ Items []map[string]any }](t, resp)
	if len(got.Items) != 2 || got.Items[0]["kind"] != "passphrase" || got.Items[1]["kind"] != "recovery" {
		t.Fatalf("envelopes: %+v", got)
	}
	// Only the owner reads them.
	expect(t, bob.json(http.MethodGet, "/vaults/"+id+"/key-envelopes", nil), http.StatusNotFound)

	// Change passphrase = replace the envelope.
	repl := envelopes()[0]
	repl["wrapped_vmk"] = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 60))
	resp = ada.json(http.MethodPut, "/vaults/"+id+"/key-envelopes/passphrase", repl)
	expect(t, resp, http.StatusOK)
	resp = ada.json(http.MethodGet, "/vaults/"+id+"/key-envelopes", nil)
	got = decode[struct{ Items []map[string]any }](t, resp)
	if got.Items[0]["wrapped_vmk"] != repl["wrapped_vmk"] {
		t.Fatal("passphrase envelope not replaced")
	}
	// ADR-0034: a v2 envelope is 61 bytes starting with 0x02; the server checks
	// nothing else. 61 bytes with another first byte, or 62 bytes, are refused.
	v2 := append([]byte{0x02}, bytes.Repeat([]byte{8}, 60)...)
	repl["wrapped_vmk"] = base64.StdEncoding.EncodeToString(v2)
	expect(t, ada.json(http.MethodPut, "/vaults/"+id+"/key-envelopes/passphrase", repl), http.StatusOK)
	got = decode[struct{ Items []map[string]any }](t, ada.json(http.MethodGet, "/vaults/"+id+"/key-envelopes", nil))
	if got.Items[0]["wrapped_vmk"] != repl["wrapped_vmk"] {
		t.Fatal("v2 passphrase envelope not stored as sent")
	}
	for name, bad := range map[string][]byte{
		"61 bytes without the v2 version byte": bytes.Repeat([]byte{3}, 61),
		"62 bytes":                             append(append([]byte(nil), v2...), 0),
	} {
		repl["wrapped_vmk"] = base64.StdEncoding.EncodeToString(bad)
		if r := ada.json(http.MethodPut, "/vaults/"+id+"/key-envelopes/passphrase", repl); r.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s accepted: %d", name, r.StatusCode)
		}
	}
	repl["wrapped_vmk"] = base64.StdEncoding.EncodeToString(v2)
	// Body kind must match the URL.
	if r := ada.json(http.MethodPut, "/vaults/"+id+"/key-envelopes/recovery", repl); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("mismatched kind: %d", r.StatusCode)
	}
	// Shared vaults have none.
	shared := ada.createVault("Plain", "shared")
	expect(t, ada.json(http.MethodGet, "/vaults/"+shared+"/key-envelopes", nil), http.StatusBadRequest)

	// The kind can never change, not even by a direct UPDATE.
	_, err := e.db.Pool.Exec(context.Background(), `UPDATE vaults SET kind='shared' WHERE id=$1`, id)
	if err == nil || !strings.Contains(err.Error(), "VAULT_KIND_IMMUTABLE") {
		t.Fatalf("kind change must be rejected by the trigger, got %v", err)
	}
}

func TestBlobTransfer(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Blobs", "shared")
	bv := bob.createVault("Blobs", "shared")

	data := []byte("hello blob world")
	h := hashOf(data)

	resp := ada.json(http.MethodPost, "/vaults/"+v+"/blobs:check", map[string]any{"hashes": []string{h, h, hashOf([]byte("x"))}})
	expect(t, resp, http.StatusOK)
	if m := decode[struct{ Missing []string }](t, resp).Missing; len(m) != 2 {
		t.Fatalf("missing: %v", m)
	}

	// A body that does not hash to the URL is refused and nothing is stored.
	expect(t, ada.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+hashOf([]byte("other")), "application/octet-stream", data, nil), http.StatusBadRequest)
	expect(t, ada.json(http.MethodPost, "/vaults/"+v+"/blobs:check", map[string]any{"hashes": []string{h}}), http.StatusOK)

	ada.putBlob(v, data)
	ada.putBlob(v, data) // idempotent
	resp = ada.json(http.MethodPost, "/vaults/"+v+"/blobs:check", map[string]any{"hashes": []string{h}})
	if m := decode[struct{ Missing []string }](t, resp).Missing; len(m) != 0 {
		t.Fatalf("still missing: %v", m)
	}

	resp = ada.json(http.MethodGet, "/vaults/"+v+"/blobs/"+h, nil)
	expect(t, resp, http.StatusOK)
	if b := readAll(t, resp); b == nil {
		t.Fatal("no body")
	}
	// Range.
	for _, c := range []struct {
		rng, want, cr string
	}{{"bytes=0-4", "hello", "bytes 0-4/16"}, {"bytes=6-", "blob world", "bytes 6-15/16"}, {"bytes=-5", "world", "bytes 11-15/16"}} {
		resp = ada.raw(http.MethodGet, "/vaults/"+v+"/blobs/"+h, "", nil, map[string]string{"Range": c.rng})
		expect(t, resp, http.StatusPartialContent)
		got := new(bytes.Buffer)
		_, _ = got.ReadFrom(resp.Body)
		if got.String() != c.want || resp.Header.Get("Content-Range") != c.cr {
			t.Errorf("range %s: %q %q", c.rng, got.String(), resp.Header.Get("Content-Range"))
		}
	}
	expect(t, ada.raw(http.MethodGet, "/vaults/"+v+"/blobs/"+h, "", nil, map[string]string{"Range": "bytes=100-"}), http.StatusRequestedRangeNotSatisfiable)

	// Bob uploaded nothing: knowing the hash gives him nothing, and check does not reveal Ada's blob.
	expect(t, bob.json(http.MethodGet, "/vaults/"+bv+"/blobs/"+h, nil), http.StatusNotFound)
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/blobs/"+h, nil), http.StatusNotFound)
	resp = bob.json(http.MethodPost, "/vaults/"+bv+"/blobs:check", map[string]any{"hashes": []string{h}})
	if m := decode[struct{ Missing []string }](t, resp).Missing; len(m) != 1 {
		t.Fatalf("blob existence leaked across users: %v", m)
	}
	// ...and he cannot reference it in a commit.
	res := bob.commit(bv, create(newID(), "a.md", h))
	if res[0].code() != "BLOB_MISSING" {
		t.Fatalf("commit with foreign blob: %v", res[0])
	}

	// 32 MB limit.
	big := bytes.Repeat([]byte{'a'}, 32<<20+1)
	resp = ada.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+hashOf(big), "application/octet-stream", big, nil)
	expect(t, resp, http.StatusRequestEntityTooLarge)
	if p := decode[syncproto.Problem](t, resp); p.Code != syncproto.CodeFileTooLarge {
		t.Fatalf("code %s", p.Code)
	}
}

func TestCommitLifecycleAndChanges(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Work", "shared")
	h1 := ada.putBlob(v, []byte("version one"))
	h2 := ada.putBlob(v, []byte("version two!"))

	f := newID()
	r := mustAccepted(t, ada.commit(v, create(f, "Projects/Alfa/plan.md", h1))[0])
	if r.rev() != 1 || r.seq() != 1 {
		t.Fatalf("create: %v", r)
	}
	// Not the same file id twice, not the same path twice (also case-insensitively).
	if res := ada.commit(v, create(f, "other.md", h1)); res[0].status() != "rejected" {
		t.Fatalf("duplicate file_id: %v", res[0])
	}
	if res := ada.commit(v, create(newID(), "projects/ALFA/Plan.md", h1)); res[0].code() != "PATH_COLLISION" {
		t.Fatalf("case collision: %v", res[0])
	}

	r = mustAccepted(t, ada.commit(v, modify(f, 1, h2))[0])
	if r.rev() != 2 {
		t.Fatalf("modify: %v", r)
	}
	// A client that still believes the file is at revision 1 gets the current state back.
	res := ada.commit(v, modify(f, 1, h1))
	if res[0].status() != "conflict" || res[0].code() != "REV_CONFLICT" || res[0]["current_rev"].(float64) != 2 || res[0]["current_hash"] != h2 {
		t.Fatalf("conflict: %v", res[0])
	}

	mustAccepted(t, ada.commit(v, move(f, 2, "Archive/plan.md"))[0])
	tree, asOf := ada.tree(v)
	if len(tree) != 1 || tree["Archive/plan.md"] == nil || tree["Archive/plan.md"]["rev"].(float64) != 3 || tree["Archive/plan.md"]["hash"] != h2 {
		t.Fatalf("tree: %v", tree)
	}
	if asOf != 3 {
		t.Fatalf("as_of_seq %d", asOf)
	}

	// Ops of one batch are independent: the failing one does not stop the others.
	g := newID()
	res = ada.commit(v, create(g, "a.md", h1), modify(f, 1, h1), create(newID(), "bad:name.md", h1), create(newID(), "b.md", h2))
	got := []string{res[0].status(), res[1].status(), res[2].code(), res[3].status()}
	if fmt.Sprint(got) != "[accepted conflict PATH_INVALID accepted]" {
		t.Fatalf("batch outcomes: %v", got)
	}

	mustAccepted(t, ada.commit(v, del(g, 1))[0])
	// Deleting twice is harmless.
	mustAccepted(t, ada.commit(v, del(g, 2))[0])
	tree, _ = ada.tree(v)
	if len(tree) != 2 || tree["a.md"] != nil {
		t.Fatalf("tree after delete: %v", tree)
	}
	// The path is free again.
	mustAccepted(t, ada.commit(v, create(newID(), "a.md", h1))[0])

	items, next, more := ada.changes(v, 0)
	if more || len(items) != int(next) || items[0]["op"] != "create" || items[0]["path"] != "Projects/Alfa/plan.md" {
		t.Fatalf("changes: next=%d items=%v", next, items)
	}
	for i, it := range items {
		if int64(it["seq"].(float64)) != int64(i+1) {
			t.Fatalf("seq not contiguous at %d: %v", i, it["seq"])
		}
	}
	var moveEntry map[string]any
	for _, it := range items {
		if it["op"] == "move" {
			moveEntry = it
		}
	}
	if moveEntry == nil || moveEntry["prev_path"] != "Projects/Alfa/plan.md" || moveEntry["path"] != "Archive/plan.md" {
		t.Fatalf("move entry: %v", moveEntry)
	}
	// Paging.
	page, nextSeq, more := ada.changes(v, 2)
	if more || len(page) != int(next)-2 || nextSeq != next {
		t.Fatalf("page: %d items next=%d", len(page), nextSeq)
	}
	resp := ada.json(http.MethodGet, "/vaults/"+v+"/changes?since=0&limit=2", nil)
	paged := decode[struct {
		Items   []any `json:"items"`
		HasMore bool  `json:"has_more"`
	}](t, resp)
	if len(paged.Items) != 2 || !paged.HasMore {
		t.Fatalf("limit: %+v", paged)
	}
}

func TestCommitIsIdempotent(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Idem", "shared")
	h := ada.putBlob(v, []byte("x"))
	op := create(newID(), "a.md", h)
	first := mustAccepted(t, ada.commit(v, op)[0])
	again := mustAccepted(t, ada.commit(v, op)[0])
	if first.seq() != again.seq() || first.rev() != again.rev() {
		t.Fatalf("retry changed the outcome: %v vs %v", first, again)
	}
	items, _, _ := ada.changes(v, 0)
	if len(items) != 1 {
		t.Fatalf("retry produced %d changelog entries", len(items))
	}
	vault := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+v, nil))
	if vault["file_count"].(float64) != 1 || vault["total_bytes"].(float64) != 1 {
		t.Fatalf("counters double counted: %v", vault)
	}
}

func TestConcurrentWritersGetExactlyOneWinner(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Race", "shared")
	h0 := ada.putBlob(v, []byte("base"))
	f := newID()
	mustAccepted(t, ada.commit(v, create(f, "race.md", h0))[0])

	const writers = 8
	hashes := make([]string, writers)
	for i := range hashes {
		hashes[i] = ada.putBlob(v, []byte(fmt.Sprintf("edit from writer %d", i)))
	}
	outcomes := make([]result, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outcomes[i] = ada.commit(v, modify(f, 1, hashes[i]))[0]
		}()
	}
	wg.Wait()
	won, conflicts := 0, 0
	for _, o := range outcomes {
		switch o.status() {
		case "accepted":
			won++
		case "conflict":
			conflicts++
		}
	}
	if won != 1 || conflicts != writers-1 {
		t.Fatalf("accepted=%d conflict=%d, want 1 and %d", won, conflicts, writers-1)
	}
	items, _, _ := ada.changes(v, 0)
	if len(items) != 2 {
		t.Fatalf("changelog has %d entries, want create + one modify", len(items))
	}
}

func TestMovePrefix(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Folders", "shared")
	h := ada.putBlob(v, []byte("x"))
	ids := []string{newID(), newID(), newID(), newID()}
	paths := []string{"Proj/a.md", "Proj/sub/b.md", "proj-notes/c.md", "Other/a.md"}
	for i := range ids {
		mustAccepted(t, ada.commit(v, create(ids[i], paths[i], h))[0])
	}
	opMove := func(from, to string) map[string]any {
		return map[string]any{"op_id": newID(), "op": "move_prefix", "from": from, "to": to}
	}

	// Only the folder and its descendants move: "proj-notes" is a different folder.
	mustAccepted(t, ada.commit(v, opMove("proj", "Archive/Proj"))[0])
	tree, _ := ada.tree(v)
	for _, want := range []string{"Archive/Proj/a.md", "Archive/Proj/sub/b.md", "proj-notes/c.md", "Other/a.md"} {
		if tree[want] == nil {
			t.Errorf("missing %s in %v", want, tree)
		}
	}
	// The whole operation fails when any target collides, and nothing moves.
	res := ada.commit(v, opMove("Archive/Proj", "Other"))
	if res[0].code() != "PATH_COLLISION" {
		t.Fatalf("collision: %v", res[0])
	}
	tree, _ = ada.tree(v)
	if tree["Archive/Proj/a.md"] == nil || tree["Other/a.md"] == nil {
		t.Fatalf("a failed move_prefix changed the tree: %v", tree)
	}
	if res := ada.commit(v, opMove("Archive", "Archive/Inside")); res[0].code() != "PATH_INVALID" {
		t.Fatalf("move into itself: %v", res[0])
	}
	if res := ada.commit(v, opMove("Nothing", "Else")); res[0].code() != "NOT_FOUND" {
		t.Fatalf("missing folder: %v", res[0])
	}
	// Each moved file has its own changelog entry.
	items, _, _ := ada.changes(v, 0)
	moves := 0
	for _, it := range items {
		if it["op"] == "move" {
			moves++
		}
	}
	if moves != 2 {
		t.Fatalf("%d move entries, want 2", moves)
	}
}

func TestPrivateVaultCommitsOpaquePaths(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createPrivateVault("Secret")
	h := ada.putBlob(v, []byte("ciphertext-ish"))
	tok := "enc1:" + strings.Repeat("A", 40)
	key := "hmac1:" + strings.Repeat("ab", 32)

	op := create(newID(), tok, h)
	if res := ada.commit(v, op); res[0].code() != "PATH_INVALID" {
		t.Fatalf("missing path_key: %v", res[0])
	}
	op["path"] = "Plain/clear.md"
	op["path_key"] = key
	if res := ada.commit(v, op); res[0].code() != "PATH_INVALID" {
		t.Fatalf("clear path accepted: %v", res[0])
	}
	op["path"] = tok
	f := mustAccepted(t, ada.commit(v, op)[0])
	if f.rev() != 1 {
		t.Fatalf("create: %v", f)
	}
	// The server enforces uniqueness through the client-computed key.
	dup := create(newID(), "enc1:"+strings.Repeat("B", 40), h)
	dup["path_key"] = key
	if res := ada.commit(v, dup); res[0].code() != "PATH_COLLISION" {
		t.Fatalf("duplicate key: %v", res[0])
	}
	tree, _ := ada.tree(v)
	if tree[tok] == nil || tree[tok]["kind"] != "opaque" {
		t.Fatalf("tree: %v", tree)
	}
	// Folder moves cannot be expressed on the server.
	res := ada.commit(v, map[string]any{"op_id": newID(), "op": "move_prefix", "from": "a", "to": "b"})
	if res[0].code() != "VAULT_ENCRYPTED" {
		t.Fatalf("move_prefix on private vault: %v", res[0])
	}
}

func TestQuotaAndFileSize(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Quota", "shared")
	if _, err := e.db.Pool.Exec(context.Background(), `UPDATE users SET quota_bytes_override = 100 WHERE id = $1`, ada.userID); err != nil {
		t.Fatal(err)
	}
	setQuota := func(n int64) {
		t.Helper()
		if _, err := e.db.Pool.Exec(context.Background(), `UPDATE users SET quota_bytes_override = $2 WHERE id = $1`, ada.userID, n); err != nil {
			t.Fatal(err)
		}
	}
	b50 := uniq('b', 50)
	h60 := ada.putBlob(v, uniq('a', 60))
	// Uploaded but uncommitted bytes count (unreferenced-upload quota): 60 + 50 do not fit in 100.
	if p := respProblem(t, ada.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+hashOf(b50), "application/octet-stream", b50, nil)); p.Code != "QUOTA_EXCEEDED" {
		t.Fatalf("upload over the quota: %+v", p)
	}

	f1 := newID()
	mustAccepted(t, ada.commit(v, create(f1, "a.md", h60))[0])
	// The commit checks the quota again: the blob was uploaded while the quota was higher.
	setQuota(1 << 40)
	h50 := ada.putBlob(v, b50)
	setQuota(100)
	if res := ada.commit(v, create(newID(), "b.md", h50)); res[0].code() != "QUOTA_EXCEEDED" {
		t.Fatalf("quota: %v", res[0])
	}
	usage := decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != 60 || usage["quota_bytes"].(float64) != 100 || usage["level"] != "ok" {
		t.Fatalf("usage: %v", usage)
	}
	// The uncommitted 50 bytes still count until committed or expired.
	c10 := uniq('c', 10)
	if p := respProblem(t, ada.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+hashOf(c10), "application/octet-stream", c10, nil)); p.Code != "QUOTA_EXCEEDED" {
		t.Fatalf("upload next to a pending blob: %+v", p)
	}
	// Replacing the file with a smaller one frees space; history does not count (D-03).
	setQuota(1 << 40)
	h10 := ada.putBlob(v, c10)
	setQuota(100)
	mustAccepted(t, ada.commit(v, modify(f1, 1, h10))[0])
	mustAccepted(t, ada.commit(v, create(newID(), "b.md", h50))[0])
	usage = decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != 60 || usage["level"] != "ok" {
		t.Fatalf("usage after: %v", usage)
	}
	// Deleting releases the space.
	mustAccepted(t, ada.commit(v, del(f1, 2))[0])
	usage = decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != 50 {
		t.Fatalf("usage after delete: %v", usage)
	}
	// Levels follow the thresholds (80 % warning, 95 % critical, 100 % full).
	for quota, want := range map[int]string{60: "warning", 52: "critical", 50: "full"} {
		if _, err := e.db.Pool.Exec(context.Background(), `UPDATE users SET quota_bytes_override = $2 WHERE id = $1`, ada.userID, quota); err != nil {
			t.Fatal(err)
		}
		if got := decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))["level"]; got != want {
			t.Errorf("quota %d: level %v, want %s", quota, got, want)
		}
	}

	// Per-file limit from the system setting.
	if _, err := e.db.Pool.Exec(context.Background(), `UPDATE settings SET value = '40' WHERE key = 'files.max_size_bytes'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = e.db.Pool.Exec(context.Background(), `UPDATE settings SET value = '104857600' WHERE key = 'files.max_size_bytes'`)
	})
	if res := ada.commit(v, create(newID(), "huge.md", h50)); res[0].code() != "FILE_TOO_LARGE" {
		t.Fatalf("file size: %v", res[0])
	}
}

func TestDeleteVersusModifyModificationWins(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("DvM", "shared")
	h1 := ada.putBlob(v, []byte("one"))
	h2 := ada.putBlob(v, []byte("two!"))
	f := newID()
	mustAccepted(t, ada.commit(v, create(f, "n.md", h1))[0])
	mustAccepted(t, ada.commit(v, del(f, 1))[0]) // device A deletes (rev 2)

	// Device B modified rev 1: conflict, which carries the tombstone state.
	res := ada.commit(v, modify(f, 1, h2))
	if res[0].status() != "conflict" || res[0]["current_rev"].(float64) != 2 || res[0]["current_hash"] != nil && res[0]["current_hash"] != "" {
		t.Fatalf("conflict against tombstone: %v", res[0])
	}
	// The client resolves "modification wins" by modifying on top of the tombstone: the file returns.
	r := mustAccepted(t, ada.commit(v, modify(f, 2, h2))[0])
	if r.rev() != 3 {
		t.Fatalf("revive: %v", r)
	}
	tree, _ := ada.tree(v)
	if tree["n.md"] == nil || tree["n.md"]["hash"] != h2 {
		t.Fatalf("tree after revive: %v", tree)
	}
	items, _, _ := ada.changes(v, 0)
	if last := items[len(items)-1]; last["op"] != "restore" {
		t.Fatalf("revival is recorded as restore, got %v", last["op"])
	}
	vault := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+v, nil))
	if vault["file_count"].(float64) != 1 || vault["total_bytes"].(float64) != 4 {
		t.Fatalf("counters: %v", vault)
	}
}

// An empty file is a valid blob: PUT with an empty body must be accepted and usable in a commit.
func TestEmptyBlob(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Empty", "shared")

	h := hashOf(nil)
	expect(t, ada.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+h, "application/octet-stream", nil, nil), http.StatusNoContent)
	// The hash is still verified for an empty body.
	expect(t, ada.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+hashOf([]byte("x")), "application/octet-stream", nil, nil), http.StatusBadRequest)

	res := ada.commit(v, create(newID(), "empty.md", h))
	if res[0].status() != "accepted" {
		t.Fatalf("commit of an empty file: %v", res[0])
	}
	resp := ada.json(http.MethodGet, "/vaults/"+v+"/blobs/"+h, nil)
	expect(t, resp, http.StatusOK)
	if b, _ := io.ReadAll(readAll(t, resp)); len(b) != 0 {
		t.Fatalf("empty blob returned %d bytes", len(b))
	}
}
