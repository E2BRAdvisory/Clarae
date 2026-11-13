//go:build integration

package integration

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	stdsync "sync"
	"testing"

	"github.com/google/uuid"

	"clarae/shared/syncproto"
)

// share-declined-status-never-set: a declined invitation is reported as
// declined, left out of the received list, and shown as declined to the owner.
func TestDeclinedInvitationIsReported(t *testing.T) {
	_, ada, bob, carol, vault, _, _ := sharedFixture(t)
	sh := ada.share(vault, "vault", "", grantTo("user", bob.userID, "editor"), grantTo("user", carol.userID, "viewer"))

	got := decode[shareView](t, bob.json(http.MethodPost, "/shares/"+sh.id()+":decline", nil))
	if got["my_status"] != "declined" {
		t.Fatalf("decline answer: %v", got)
	}
	if got := decode[shareView](t, bob.json(http.MethodGet, "/shares/"+sh.id(), nil)); got["my_status"] != "declined" || got["my_permission"] != nil && got["my_permission"] != "none" {
		t.Fatalf("declined share: %v", got)
	}
	if l := pageItems[shareView](t, bob.json(http.MethodGet, "/shares?scope=received", nil)); len(l) != 0 {
		t.Fatalf("a declined invitation is not an open one: %v", l)
	}
	if l := pageItems[shareView](t, carol.json(http.MethodGet, "/shares?scope=received", nil)); len(l) != 1 || l[0]["my_status"] != "pending" || l[0]["my_permission"] != "viewer" {
		t.Fatalf("carol's pending invitation: %v", l)
	}
	owned := pageItems[shareView](t, ada.json(http.MethodGet, "/shares?scope=owned", nil))
	if len(owned) != 1 {
		t.Fatalf("owned: %v", owned)
	}
	statuses := map[string]string{}
	for _, g := range owned[0]["grants"].([]any) {
		m := g.(map[string]any)
		statuses[m["principal_id"].(string)] = m["status"].(string)
	}
	if statuses[bob.userID] != "declined" || statuses[carol.userID] != "pending" {
		t.Fatalf("grant statuses: %v", statuses)
	}
	// Accepting later is still possible.
	bob.accept(sh.id())
	if l := pageItems[shareView](t, bob.json(http.MethodGet, "/shares?scope=received", nil)); len(l) != 1 || l[0]["my_status"] != "accepted" {
		t.Fatalf("after accepting: %v", l)
	}
}

// sharing-list-n-plus-one-swallowed-errors: the lists are built with a fixed
// number of queries and carry, for many shares, the same data as one GET.
func TestShareListsMatchSingleViews(t *testing.T) {
	e, ada, bob, carol, vault, _, group := sharedFixture(t)
	other := ada.createVault("Second", "shared")
	ada.seed(other, map[string]string{"Docs/a.md": "a"})
	var ids []string
	ids = append(ids, ada.share(vault, "vault", "", grantTo("user", bob.userID, "manager")).id())
	ids = append(ids, ada.share(vault, "folder", "Projects/Alfa", grantTo("group", group.String(), "editor")).id())
	ids = append(ids, ada.share(other, "folder", "Docs", grantTo("user", bob.userID, "viewer"), grantTo("user", carol.userID, "editor")).id())
	bob.accept(ids[0])
	bob.accept(ids[2])
	_ = e

	check := func(c *client, scope string, want int) {
		t.Helper()
		list := pageItems[shareView](t, c.json(http.MethodGet, "/shares?scope="+scope, nil))
		if len(list) != want {
			t.Fatalf("%s %s: %d shares, want %d", c.userID, scope, len(list), want)
		}
		for _, item := range list {
			single := decode[shareView](t, c.json(http.MethodGet, "/shares/"+item.id(), nil))
			for _, k := range []string{"vault_name", "owner_name", "my_status", "my_permission", "path_prefix", "resource_type"} {
				if fmt.Sprint(item[k]) != fmt.Sprint(single[k]) {
					t.Errorf("%s: %s differs: list %v, single %v", item.id(), k, item[k], single[k])
				}
			}
			if (item["grants"] == nil) != (single["grants"] == nil) || fmt.Sprint(item["grants"]) != fmt.Sprint(single["grants"]) {
				t.Errorf("%s: grants differ: list %v, single %v", item.id(), item["grants"], single["grants"])
			}
		}
	}
	check(ada, "owned", 3)
	check(bob, "owned", 1) // the manager
	check(bob, "received", 3)
	check(carol, "received", 2)
}

// export-queue-unbounded: a vault has one active export job (a new request
// joins it) and a user a bounded number (RATE_LIMITED beyond).
func TestExportJobsAreDedupedAndCapped(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	var vaults []string
	for i := range 4 {
		v := ada.createVault(fmt.Sprintf("V%d", i), "shared")
		ada.seed(v, map[string]string{"a.md": "a"})
		vaults = append(vaults, v)
	}
	create := func(v string) *http.Response { return ada.json(http.MethodPost, "/vaults/"+v+"/exports", nil) }
	first := decode[map[string]any](t, create(vaults[0]))
	again := decode[map[string]any](t, create(vaults[0]))
	if first["id"] != again["id"] {
		t.Fatalf("a second request for the same vault joins the queued job: %v %v", first["id"], again["id"])
	}
	expect(t, create(vaults[1]), http.StatusAccepted)
	expect(t, create(vaults[2]), http.StatusAccepted)
	resp := create(vaults[3])
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("fourth active export: %d", resp.StatusCode)
	}
	if p := respProblem(t, resp); p.Code != syncproto.CodeRateLimited || p.Extra["limit"] != float64(3) {
		t.Fatalf("problem: %+v", p)
	}
	// Processing frees the slots; a running job shows no expiry (that is its lease).
	if n, err := e.app.Exports.ProcessPending(context.Background()); err != nil || n < 3 {
		t.Fatalf("process: %d %v", n, err)
	}
	expect(t, create(vaults[3]), http.StatusAccepted)
	if got := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+vaults[0]+"/exports/"+first["id"].(string), nil)); got["status"] != "ready" || got["expires_at"] == nil {
		t.Fatalf("finished job: %v", got)
	}
	if _, err := e.app.Exports.ProcessPending(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// A job that waited long in the queue is not mistaken for an abandoned one
// once it runs: staleness is the running job's lease, not its age.
func TestRunningExportKeepsItsLease(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Lease", "shared")
	ada.seed(v, map[string]string{"a.md": "a"})
	job := decode[map[string]any](t, ada.json(http.MethodPost, "/vaults/"+v+"/exports", nil))
	ctx := context.Background()
	if _, err := e.db.Pool.Exec(ctx, `UPDATE export_jobs SET created_at = now() - interval '3 hours', status = 'running', expires_at = now() + interval '50 minutes' WHERE id = $1`, job["id"]); err != nil {
		t.Fatal(err)
	}
	if err := e.app.Exports.Expire(ctx); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := e.db.Pool.QueryRow(ctx, `SELECT status FROM export_jobs WHERE id = $1`, job["id"]).Scan(&status); err != nil || status != "running" {
		t.Fatalf("a running job with a live lease was requeued: %s %v", status, err)
	}
	if _, err := e.db.Pool.Exec(ctx, `UPDATE export_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1`, job["id"]); err != nil {
		t.Fatal(err)
	}
	if err := e.app.Exports.Expire(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e.db.Pool.QueryRow(ctx, `SELECT status FROM export_jobs WHERE id = $1`, job["id"]).Scan(&status); err != nil || status != "queued" {
		t.Fatalf("an expired lease requeues the job: %s %v", status, err)
	}
	if _, err := e.app.Exports.ProcessPending(ctx); err != nil {
		t.Fatal(err)
	}
}

// concurrent-retry-conflict: a commit resent while the original is still
// running gets the original outcome of every operation (op_id idempotency),
// never REV_CONFLICT for its own writes.
func TestConcurrentRetryIsRecognisedByOpID(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Retry", "shared")
	const n = 100
	user, vault, device := uuid.MustParse(ada.userID), uuid.MustParse(v), uuid.MustParse(ada.deviceID)
	ctx := context.Background()
	put := func(data []byte) string {
		h := hashOf(data)
		if err := e.app.Blobs.Put(ctx, user, vault, "", h, bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		return h
	}
	base := put([]byte("base"))
	var creates, modifies []syncproto.Op
	for i := range n {
		id := newID()
		creates = append(creates, syncproto.Op{OpID: newID(), Op: syncproto.OpCreate, FileID: id, Path: fmt.Sprintf("r/%03d.md", i), BlobHash: base})
		one := 1
		modifies = append(modifies, syncproto.Op{OpID: newID(), Op: syncproto.OpModify, FileID: id, BaseRev: &one, BlobHash: put([]byte(fmt.Sprintf("v2 %d", i)))})
	}
	if _, err := e.app.Sync.Commit(ctx, user, vault, "", device, creates); err != nil {
		t.Fatal(err)
	}
	for round := range 3 {
		ops := modifies
		if round > 0 { // fresh operations each round, based on the previous one
			ops = make([]syncproto.Op, n)
			for i, m := range modifies {
				b := round + 1
				ops[i] = syncproto.Op{OpID: newID(), Op: syncproto.OpModify, FileID: m.FileID, BaseRev: &b, BlobHash: put([]byte(fmt.Sprintf("v%d %d", round+2, i)))}
			}
		}
		var wg stdsync.WaitGroup
		resps := make([]syncproto.CommitResponse, 3)
		errs := make([]error, 3)
		for k := range resps {
			wg.Add(1)
			go func() {
				defer wg.Done()
				resps[k], errs[k] = e.app.Sync.Commit(ctx, user, vault, "", device, ops)
			}()
		}
		wg.Wait()
		for k := range resps {
			if errs[k] != nil {
				t.Fatal(errs[k])
			}
			for i, r := range resps[k].Results {
				if r.Status != syncproto.StatusAccepted || r != resps[0].Results[i] {
					t.Fatalf("round %d, copy %d, op %d: %+v (first copy: %+v)", round, k, i, r, resps[0].Results[i])
				}
			}
		}
	}
}

// unbounded-tree-and-job-scans: the manifest is streamed page by page from one
// snapshot, and a share's manifest is filtered in the query (prefix matched
// by path key, LIKE metacharacters escaped, sibling folders excluded).
func TestTreeIsStreamedAndScopedInSQL(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Tree", "shared")
	user, vault, device := uuid.MustParse(ada.userID), uuid.MustParse(v), uuid.MustParse(ada.deviceID)
	ctx := context.Background()
	h := hashOf([]byte("x"))
	if err := e.app.Blobs.Put(ctx, user, vault, "", h, bytes.NewReader([]byte("x"))); err != nil {
		t.Fatal(err)
	}
	const files = 2100 // more than two pages
	var ops []syncproto.Op
	for i := range files {
		ops = append(ops, syncproto.Op{OpID: newID(), Op: syncproto.OpCreate, FileID: newID(), Path: fmt.Sprintf("bulk/%04d.md", i), BlobHash: h})
		if len(ops) == syncproto.MaxOpsPerCommit || i == files-1 {
			if _, err := e.app.Sync.Commit(ctx, user, vault, "", device, ops); err != nil {
				t.Fatal(err)
			}
			ops = nil
		}
	}
	ids := ada.seed(v, map[string]string{"a_b%/in.md": "in", "a_b%/sub/deep.md": "deep", "aXb%/out.md": "out", "a_b%2/out.md": "out", "A_B%.md": "out"})

	paths, asOf := ada.tree(v)
	if len(paths) != files+5 {
		t.Fatalf("owner tree: %d entries, want %d", len(paths), files+5)
	}
	var last int64
	if err := e.db.Pool.QueryRow(ctx, `SELECT last_seq FROM vaults WHERE id = $1`, v).Scan(&last); err != nil || asOf != last {
		t.Fatalf("as_of_seq %d, last_seq %d (%v)", asOf, last, err)
	}

	scoped := func(share string) []string {
		t.Helper()
		resp := bob.json(http.MethodGet, "/vaults/"+v+"/tree?scope=share:"+share, nil)
		expect(t, resp, http.StatusOK)
		var out []string
		for _, it := range decode[struct{ Items []map[string]any }](t, resp).Items {
			out = append(out, it["path"].(string))
		}
		sort.Strings(out)
		return out
	}
	folder := ada.share(v, "folder", "A_B%", grantTo("user", bob.userID, "viewer")) // case-folded match
	bob.accept(folder.id())
	if got := strings.Join(scoped(folder.id()), ","); got != "in.md,sub/deep.md" {
		t.Fatalf("folder share tree: %s", got)
	}
	resp := ada.json(http.MethodPost, "/shares", map[string]any{
		"vault_id": v, "resource_type": "file", "file_id": ids["a_b%/sub/deep.md"], "display_name": "Deep",
		"grants": []map[string]any{grantTo("user", bob.userID, "viewer")},
	})
	expect(t, resp, http.StatusCreated)
	doc := decode[shareView](t, resp)
	bob.accept(doc.id())
	if got := strings.Join(scoped(doc.id()), ","); got != "deep.md" {
		t.Fatalf("document share tree: %s", got)
	}
}

// move-prefix-unused (ADR-0040): move_prefix stays; a rename that only changes
// letter case is a rename, not "a folder cannot move into itself".
func TestMovePrefixCaseOnlyRename(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Case", "shared")
	ada.seed(v, map[string]string{"notes/a.md": "a", "notes/sub/b.md": "b"})
	sh := ada.share(v, "folder", "notes/sub", grantTo("user", bob.userID, "viewer"))
	bob.accept(sh.id())
	mustAccepted(t, ada.commit(v, map[string]any{"op_id": newID(), "op": "move_prefix", "from": "notes", "to": "Notes"})[0])
	paths, _ := ada.tree(v)
	if _, ok := paths["Notes/a.md"]; !ok {
		t.Fatalf("tree after the case-only rename: %v", paths)
	}
	if got := decode[shareView](t, ada.json(http.MethodGet, "/shares/"+sh.id(), nil)); got["path_prefix"] != "Notes/sub" {
		t.Fatalf("the share follows: %v", got["path_prefix"])
	}
	res := ada.commit(v, map[string]any{"op_id": newID(), "op": "move_prefix", "from": "Notes", "to": "Notes"})
	if res[0].code() != "VALIDATION_FAILED" {
		t.Fatalf("unchanged path: %v", res[0])
	}
	if res := ada.commit(v, map[string]any{"op_id": newID(), "op": "move_prefix", "from": "Notes", "to": "notes/inner"}); res[0].code() != "PATH_INVALID" {
		t.Fatalf("into itself: %v", res[0])
	}
}

// ADR-0042: enc2 path tokens (bound to vault and file) are accepted like enc1,
// with the same hmac1 key semantics, in the same vault as enc1 tokens; a move
// that only re-encrypts the path keeps its key and is accepted.
func TestPrivateVaultAcceptsEnc2PathTokens(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createPrivateVault("Secret v2")
	h := ada.putBlob(v, []byte("ciphertext"))
	tok := func(prefix, c string) string { return prefix + strings.Repeat(c, 40) }
	key := func(c string) string { return "hmac1:" + strings.Repeat(c, 64) }
	opaque := func(op map[string]any, path, k string) map[string]any {
		op["path"], op["path_key"] = path, k
		return op
	}

	f1, f2 := newID(), newID()
	mustAccepted(t, ada.commit(v, opaque(create(f1, "", h), tok("enc1:", "A"), key("a")))[0])
	mustAccepted(t, ada.commit(v, opaque(create(f2, "", h), tok("enc2:", "B"), key("b")))[0])
	// Uniqueness is the hmac key, whatever the token format.
	if res := ada.commit(v, opaque(create(newID(), "", h), tok("enc2:", "C"), key("a"))); res[0].code() != "PATH_COLLISION" {
		t.Fatalf("enc2 onto an enc1 key: %v", res[0])
	}
	if res := ada.commit(v, opaque(move(f1, 1, ""), tok("enc1:", "D"), key("b"))); res[0].code() != "PATH_COLLISION" {
		t.Fatalf("move onto an enc2 key: %v", res[0])
	}
	// Re-encryption in place: enc1 to enc2 with the file's own key.
	mustAccepted(t, ada.commit(v, opaque(move(f1, 1, ""), tok("enc2:", "E"), key("a")))[0])
	mustAccepted(t, ada.commit(v, opaque(move(f2, 1, ""), tok("enc2:", "F"), key("f")))[0])
	tree, _ := ada.tree(v)
	if tree[tok("enc2:", "E")] == nil || tree[tok("enc2:", "F")] == nil || len(tree) != 2 {
		t.Fatalf("tree: %v", tree)
	}
	for _, bad := range []string{"enc3:" + strings.Repeat("G", 40), "enc2:" + strings.Repeat("H", 20) + "/x" + strings.Repeat("H", 20)} {
		if res := ada.commit(v, opaque(create(newID(), "", h), bad, key("9"))); res[0].code() != "PATH_INVALID" {
			t.Fatalf("%s: %v", bad, res[0])
		}
	}
}

// Shared vaults refuse names no Windows client could create (NormalizePortable).
func TestSharedVaultRefusesWindowsReservedNames(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Portable", "shared")
	h := ada.putBlob(v, []byte("x"))
	for _, p := range []string{"NUL.md", "docs/com1.txt", "Aux /a.md"} {
		if res := ada.commit(v, create(newID(), p, h)); res[0].code() != "PATH_INVALID" {
			t.Errorf("%s: %v", p, res[0])
		}
	}
	f := newID()
	mustAccepted(t, ada.commit(v, create(f, "docs/ok.md", h))[0])
	if res := ada.commit(v, move(f, 1, "LPT1.md")); res[0].code() != "PATH_INVALID" {
		t.Errorf("move to a reserved name: %v", res[0])
	}
	if res := ada.commit(v, map[string]any{"op_id": newID(), "op": "move_prefix", "from": "docs", "to": "CON"}); res[0].code() != "PATH_INVALID" {
		t.Errorf("folder rename to a reserved name: %v", res[0])
	}
}
