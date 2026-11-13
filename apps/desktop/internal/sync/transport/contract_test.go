//go:build integration

package transport_test

// Contract tests (ADR-0037 §3): the real transport client against the real
// cloud service, with every request and every response it exchanges validated
// against api/openapi.yaml by kin-openapi's openapi3filter, problem documents
// included. They live here rather than in services/cloud/test because the
// client is an internal package of this module; cloudtest starts the service.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
	"github.com/google/uuid"

	"clarae/apps/desktop/internal/cloudtest"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/apiclient"
	"clarae/shared/hashing"
	"clarae/shared/syncproto"
)

var (
	env      *cloudtest.Env
	spec     *openapi3.T
	router   routers.Router
	recorder = &contractRecorder{seen: map[string]int{}}
)

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	loader := openapi3.NewLoader()
	var err error
	if spec, err = loader.LoadFromFile(filepath.Join("..", "..", "..", "..", "..", "api", "openapi.yaml")); err != nil {
		log.Print(err)
		return 1
	}
	if err := spec.Validate(loader.Context); err != nil {
		log.Printf("spec invalid: %v", err)
		return 1
	}
	if router, err = gorillamux.NewRouter(spec); err != nil {
		log.Print(err)
		return 1
	}
	if env, err = cloudtest.Start(ctx); err != nil {
		log.Print(err)
		return 1
	}
	defer env.Stop()
	code := m.Run()
	if code != 0 {
		log.Printf("cloud service log:\n%s", env.Log())
	}
	return code
}

// outsideContract are the routes the client may call although the spec does
// not describe them as operations (see the info section of openapi.yaml).
var outsideContract = regexp.MustCompile(`^/api/v1/(vaults/[^/]+/uploads|uploads/[^/]+|events)$`)

// notUsedByTransport are the end-user operations the desktop transport does
// not call; any other operation of the spec must be exercised below, so a new
// operation forces a decision here.
var notUsedByTransport = []string{
	"healthz", "readyz", // probes
	"deleteMyAccount", "exportMyData", "listMyGroups", // console only (privacy, profile)
	"exportVaultZip", "createExport", "getExport", "downloadExport", // console only (exports)
}

// contractRecorder collects violations and the operations seen.
type contractRecorder struct {
	mu         sync.Mutex
	seen       map[string]int // operationId -> calls
	violations []string
	outside    int
}

func (r *contractRecorder) fail(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.violations = append(r.violations, fmt.Sprintf(format, args...))
}

// validating is an http.RoundTripper that checks each exchange against the spec.
type validating struct{ next http.RoundTripper }

func (v validating) RoundTrip(req *http.Request) (*http.Response, error) {
	var reqBody []byte
	if req.Body != nil {
		var err error
		if reqBody, err = io.ReadAll(req.Body); err != nil {
			return nil, err
		}
		_ = req.Body.Close()
		req.Body = io.NopCloser(bytes.NewReader(reqBody))
	}
	what := req.Method + " " + req.URL.Path
	route, pathParams, err := router.FindRoute(req)
	if err != nil {
		if !outsideContract.MatchString(req.URL.Path) {
			recorder.fail("%s: not in the spec: %v", what, err)
		} else {
			recorder.mu.Lock()
			recorder.outside++
			recorder.mu.Unlock()
		}
		return v.next.RoundTrip(req)
	}
	what = route.Operation.OperationID + " (" + what + ")"
	recorder.mu.Lock()
	recorder.seen[route.Operation.OperationID]++
	recorder.mu.Unlock()

	in := &openapi3filter.RequestValidationInput{
		Request: req, PathParams: pathParams, Route: route,
		Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc, MultiError: true},
	}
	if err := openapi3filter.ValidateRequest(req.Context(), in); err != nil {
		recorder.fail("%s: request violates the spec: %v", what, err)
	}
	if req.Body != nil {
		req.Body = io.NopCloser(bytes.NewReader(reqBody))
	}

	resp, err := v.next.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	respBody, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return nil, err
	}
	resp.Body = io.NopCloser(bytes.NewReader(respBody))
	if err := openapi3filter.ValidateResponse(req.Context(), &openapi3filter.ResponseValidationInput{
		RequestValidationInput: in, Status: resp.StatusCode, Header: resp.Header, Body: io.NopCloser(bytes.NewReader(respBody)),
		Options: &openapi3filter.Options{IncludeResponseStatus: true, MultiError: true},
	}); err != nil {
		recorder.fail("%s -> %d: response violates the spec: %v\n%s", what, resp.StatusCode, err, truncate(respBody))
	}
	return resp, nil
}

func truncate(b []byte) string {
	if len(b) > 512 {
		return string(b[:512]) + "…"
	}
	return string(b)
}

type tokens struct{ user string }

func (t tokens) Token(context.Context) (string, error) { return env.Issuer.Token(t.user), nil }

func client(t *testing.T, user string) *transport.Client {
	t.Helper()
	var tok transport.TokenSource
	if user != "" {
		tok = tokens{user}
	}
	c, err := transport.New(env.ServerURL, tok, &http.Client{Timeout: time.Minute, Transport: validating{next: http.DefaultTransport}}, "contract-test")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries = 0 // a retry would hide a 5xx from the contract
	return c
}

func must[T any](t *testing.T, what string) func(T, error) T {
	t.Helper()
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		return v
	}
}

func check(t *testing.T, what string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", what, err)
	}
}

func wantCode(t *testing.T, what string, err error, code syncproto.Code) {
	t.Helper()
	if !transport.IsCode(err, code) {
		t.Fatalf("%s: want %s, got %v", what, code, err)
	}
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// TestTransportHonoursTheContract drives every transport method at least once.
func TestTransportHonoursTheContract(t *testing.T) {
	ctx := context.Background()
	ada, bob, carol := client(t, "ada"), client(t, "bob"), client(t, "carol")

	// --- account ---
	cc := must[transport.ClientConfig](t, "client config")(client(t, "").GetClientConfig(ctx))
	if cc.Audience != "clarae-api" {
		t.Fatalf("client config: %+v", cc)
	}
	me := must[transport.Me](t, "me")(ada.GetMe(ctx))
	bobMe := must[transport.Me](t, "bob me")(bob.GetMe(ctx))
	carolMe := must[transport.Me](t, "carol me")(carol.GetMe(ctx))
	appVersion := "1.0.0"
	dev := must[transport.Device](t, "register")(ada.RegisterDevice(ctx, transport.DeviceRegistration{Name: "laptop", Platform: apiclient.Linux, AppVersion: &appVersion}))
	spare := must[transport.Device](t, "register spare")(ada.RegisterDevice(ctx, transport.DeviceRegistration{Name: "old", Platform: apiclient.Macos}))
	devs := must[[]transport.Device](t, "devices")(ada.ListDevices(ctx))
	if len(devs) < 2 {
		t.Fatalf("devices: %+v", devs)
	}
	check(t, "revoke device", ada.RevokeDevice(ctx, spare.Id.String()))
	wantCode(t, "revoke unknown device", ada.RevokeDevice(ctx, uuid.NewString()), syncproto.CodeNotFound)
	must[transport.Usage](t, "usage")(ada.GetUsage(ctx))
	cfg, etag, changed, err := ada.GetEffectiveConfig(ctx, "")
	check(t, "effective config", err)
	if !changed || etag == "" || cfg.Config == nil {
		t.Fatalf("effective config: %+v %q %v", cfg, etag, changed)
	}
	if _, _, changed, err := ada.GetEffectiveConfig(ctx, etag); err != nil || changed {
		t.Fatalf("conditional effective config: changed=%v err=%v", changed, err)
	}

	// --- vaults ---
	shared := must[transport.Vault](t, "create shared vault")(ada.CreateVault(ctx, "Contract", "shared", nil))
	vid := shared.Id.String()
	_, err = ada.CreateVault(ctx, "Contract", "shared", nil)
	wantCode(t, "duplicate vault name", err, syncproto.CodeNameInUse)
	salt := base64.StdEncoding.EncodeToString(randomBytes(16))
	three, mem, four := 3, 64*1024, 4
	envs := []transport.KeyEnvelope{
		{Kind: apiclient.Passphrase, Kdf: transport.KDF{Alg: apiclient.Argon2id, T: &three, MKib: &mem, P: &four, Salt: salt}, WrappedVmk: randomBytes(60)},
		{Kind: apiclient.Recovery, Kdf: transport.KDF{Alg: apiclient.HkdfSha256, Salt: salt}, WrappedVmk: randomBytes(60)},
	}
	private := must[transport.Vault](t, "create private vault")(ada.CreateVault(ctx, "Private contract", "private", envs))
	got := must[[]transport.KeyEnvelope](t, "key envelopes")(ada.GetKeyEnvelopes(ctx, private.Id.String()))
	if len(got) != 2 {
		t.Fatalf("envelopes: %+v", got)
	}
	envs[0].WrappedVmk = randomBytes(60)
	check(t, "put key envelope", ada.PutKeyEnvelope(ctx, private.Id.String(), envs[0]))
	if v := must[transport.Vault](t, "get vault")(ada.GetVault(ctx, vid)); v.Name != "Contract" {
		t.Fatalf("vault: %+v", v)
	}
	_, err = ada.GetVault(ctx, uuid.NewString())
	wantCode(t, "unknown vault", err, syncproto.CodeNotFound)
	if v := must[transport.Vault](t, "rename vault")(ada.RenameVault(ctx, private.Id.String(), "Private renamed")); v.Name != "Private renamed" {
		t.Fatalf("renamed: %+v", v)
	}
	_, err = ada.RenameVault(ctx, private.Id.String(), "Contract")
	wantCode(t, "rename onto a used name", err, syncproto.CodeNameInUse)

	// Lifecycle: delete, list the deleted ones, restore.
	check(t, "delete vault", ada.DeleteVault(ctx, private.Id.String()))
	active := must[[]transport.Vault](t, "list vaults")(ada.ListVaults(ctx))
	if slices.ContainsFunc(active, func(v transport.Vault) bool { return v.Id == private.Id }) {
		t.Fatal("a deleted vault is listed")
	}
	deleted := must[[]transport.Vault](t, "list deleted vaults")(ada.ListDeletedVaults(ctx))
	if len(deleted) != 1 || deleted[0].Id != private.Id || deleted[0].DeletedAt == nil {
		t.Fatalf("deleted vaults: %+v", deleted)
	}
	if others := must[[]transport.Vault](t, "bob's deleted vaults")(bob.ListDeletedVaults(ctx)); len(others) != 0 {
		t.Fatalf("bob sees ada's deleted vaults: %+v", others)
	}
	_, err = ada.GetVault(ctx, private.Id.String())
	wantCode(t, "deleted vault", err, syncproto.CodeNotFound)
	if v := must[transport.Vault](t, "restore vault")(ada.RestoreVault(ctx, private.Id.String())); v.DeletedAt != nil {
		t.Fatalf("restored: %+v", v)
	}
	_, err = ada.RestoreVault(ctx, private.Id.String())
	wantCode(t, "restore a live vault", err, syncproto.CodeValidationFailed)
	if deleted := must[[]transport.Vault](t, "list deleted vaults")(ada.ListDeletedVaults(ctx)); len(deleted) != 0 {
		t.Fatalf("still deleted: %+v", deleted)
	}

	// --- sync ---
	content := []byte("# plan\n\nline 1\n")
	hash := hashing.Sum(content).Hex()
	big := randomBytes(64 << 10)
	bigHash := hashing.Sum(big).Hex()
	missing := must[[]string](t, "check blobs")(ada.CheckBlobs(ctx, vid, []string{hash, bigHash}))
	if len(missing) != 2 {
		t.Fatalf("missing: %v", missing)
	}
	check(t, "put blob", ada.PutBlob(ctx, vid, hash, content))
	if _, err := ada.TusUpload(ctx, vid, bigHash, big, "", nil); err != nil {
		t.Fatalf("tus upload: %v", err)
	}
	if missing := must[[]string](t, "check blobs")(ada.CheckBlobs(ctx, vid, []string{hash, bigHash})); len(missing) != 0 {
		t.Fatalf("still missing: %v", missing)
	}
	fileID, bigID := uuid.NewString(), uuid.NewString()
	res := must[syncproto.CommitResponse](t, "commit")(ada.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: dev.Id.String(), Ops: []syncproto.Op{
		{OpID: uuid.NewString(), Op: syncproto.OpCreate, FileID: fileID, Path: "Docs/plan.md", BlobHash: hash, Size: int64(len(content))},
		{OpID: uuid.NewString(), Op: syncproto.OpCreate, FileID: bigID, Path: "Docs/big.bin", BlobHash: bigHash, Size: int64(len(big))},
	}}))
	for _, r := range res.Results {
		if r.Status != syncproto.StatusAccepted {
			t.Fatalf("commit: %+v", res)
		}
	}
	content2 := []byte("# plan\n\nline 1\nline 2\n")
	hash2 := hashing.Sum(content2).Hex()
	check(t, "put blob 2", ada.PutBlob(ctx, vid, hash2, content2))
	base := 1
	res = must[syncproto.CommitResponse](t, "commit modify")(ada.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: dev.Id.String(), Ops: []syncproto.Op{
		{OpID: uuid.NewString(), Op: syncproto.OpModify, FileID: fileID, BaseRev: &base, BlobHash: hash2, Size: int64(len(content2))},
	}}))
	// A stale base revision is a per-operation conflict inside a 200.
	res = must[syncproto.CommitResponse](t, "commit conflict")(ada.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: dev.Id.String(), Ops: []syncproto.Op{
		{OpID: uuid.NewString(), Op: syncproto.OpModify, FileID: fileID, BaseRev: &base, BlobHash: hash, Size: int64(len(content))},
	}}))
	if res.Results[0].Status != syncproto.StatusConflict || res.Results[0].Code != syncproto.CodeRevConflict {
		t.Fatalf("conflict: %+v", res)
	}
	// The revoked device: a FORBIDDEN problem the client recognises (extra.reason), whole request refused.
	_, err = ada.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: spare.Id.String(), Ops: []syncproto.Op{
		{OpID: uuid.NewString(), Op: syncproto.OpModify, FileID: fileID, BaseRev: &base, BlobHash: hash, Size: int64(len(content))},
	}})
	if !transport.IsCode(err, syncproto.CodeForbidden) || !transport.IsDeviceRevoked(err) {
		t.Fatalf("commit with a revoked device: %v", err)
	}
	// A well-formed request the server refuses: the problem document is validated too.
	_, err = ada.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: uuid.NewString(), Ops: []syncproto.Op{
		{OpID: uuid.NewString(), Op: syncproto.OpDelete, FileID: fileID, BaseRev: &base},
	}})
	wantCode(t, "commit from an unknown device", err, syncproto.CodeValidationFailed)

	changes := must[transport.Changes](t, "changes")(ada.GetChanges(ctx, vid, 0, "", 10))
	if len(changes.Items) != 3 || changes.Items[0].FileID != fileID || changes.Items[0].AuthorID != me.Id.String() || changes.Items[0].DeviceID != dev.Id.String() {
		t.Fatalf("changes: %+v", changes)
	}
	tree := must[transport.Tree](t, "tree")(ada.GetTree(ctx, vid))
	if len(tree.Items) != 2 || tree.AsOfSeq != changes.NextSeq || tree.AsOfID == "" || tree.AsOfID != changes.NextID {
		t.Fatalf("tree: %+v (changes %+v)", tree, changes)
	}
	// The cursor with its identity continues; with another id it is refused as
	// a cursor of a timeline the server lost (ADR-0046).
	if again := must[transport.Changes](t, "changes at the head")(ada.GetChanges(ctx, vid, changes.NextSeq, changes.NextID, 10)); len(again.Items) != 0 || again.NextID != changes.NextID {
		t.Fatalf("changes at the head: %+v", again)
	}
	_, err = ada.GetChanges(ctx, vid, changes.NextSeq, uuid.Must(uuid.NewV7()).String(), 10)
	if !transport.ServerBehind(err) {
		t.Fatalf("changes with another id at the cursor: %v", err)
	}
	var buf bytes.Buffer
	if n := must[int64](t, "get blob")(ada.GetBlob(ctx, vid, hash2, &buf)); n != int64(len(content2)) || buf.String() != string(content2) {
		t.Fatalf("blob: %q", buf.String())
	}
	_, err = ada.GetBlob(ctx, vid, strings.Repeat("f", 64), io.Discard)
	wantCode(t, "unknown blob", err, syncproto.CodeNotFound)

	// --- history ---
	revs, _, err := ada.ListRevisions(ctx, vid, fileID, 10, "")
	check(t, "revisions", err)
	if len(revs) != 2 || revs[0].Rev != 2 {
		t.Fatalf("revisions: %+v", revs)
	}
	buf.Reset()
	if _, err := ada.GetRevisionContent(ctx, vid, fileID, 1, &buf); err != nil || buf.String() != string(content) {
		t.Fatalf("revision content: %q %v", buf.String(), err)
	}
	if r := must[syncproto.OpResult](t, "restore revision")(ada.RestoreRevision(ctx, vid, fileID, 1)); r.Status != syncproto.StatusAccepted || r.Rev != 3 {
		t.Fatalf("restore: %+v", r)
	}

	// --- sharing, grants, invitations, directory ---
	users := must[[]transport.DirectoryUser](t, "search users")(ada.SearchUsers(ctx, "bob"))
	if !slices.ContainsFunc(users, func(u transport.DirectoryUser) bool { return u.Id == bobMe.Id }) {
		t.Fatalf("directory: %+v", users)
	}
	must[[]transport.DirectoryGroup](t, "search groups")(ada.SearchGroups(ctx, "team"))
	prefix := "Docs"
	grants := []transport.NewGrant{{PrincipalType: apiclient.NewGrantPrincipalTypeUser, PrincipalId: bobMe.Id, Permission: apiclient.SharePermissionEditor}}
	share := must[transport.Share](t, "create share")(ada.CreateShare(ctx, transport.CreateShare{VaultId: shared.Id, ResourceType: apiclient.ResourceTypeFolder, PathPrefix: &prefix, DisplayName: "Docs", Grants: &grants}))
	sid := share.Id.String()
	must[transport.Share](t, "get share")(ada.GetShare(ctx, sid))
	name := "Documents"
	expiry := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	if s := must[transport.Share](t, "update share")(ada.UpdateShare(ctx, sid, &name, &expiry, false)); s.DisplayName != name || s.ExpiresAt == nil {
		t.Fatalf("updated: %+v", s)
	}
	if s := must[transport.Share](t, "clear expiry")(ada.UpdateShare(ctx, sid, nil, nil, true)); s.ExpiresAt != nil {
		t.Fatalf("expiry not cleared: %+v", s)
	}
	must[transport.Grant](t, "put grant")(ada.PutGrant(ctx, sid, "user", carolMe.Id.String(), "viewer"))
	check(t, "delete grant", ada.DeleteGrant(ctx, sid, "user", carolMe.Id.String()))
	owned := must[[]transport.Share](t, "owned shares")(ada.ListShares(ctx, "owned"))
	if len(owned) == 0 {
		t.Fatal("no owned shares")
	}
	received := must[[]transport.Share](t, "received shares")(bob.ListShares(ctx, "received"))
	if !slices.ContainsFunc(received, func(s transport.Share) bool { return s.Id == share.Id }) {
		t.Fatalf("received: %+v", received)
	}
	must[transport.Share](t, "accept share")(bob.AcceptShare(ctx, sid))
	mounts := must[[]transport.Mount](t, "shared with me")(bob.SharedWithMe(ctx))
	if len(mounts) != 1 || mounts[0].ShareId != share.Id {
		t.Fatalf("mounts: %+v", mounts)
	}
	ref := transport.Ref(vid, mounts[0].Scope)
	if tr := must[transport.Tree](t, "tree through the share")(bob.GetTree(ctx, ref)); len(tr.Items) != 2 || tr.Items[0].Path == "Docs/big.bin" {
		t.Fatalf("scoped tree: %+v", tr)
	}
	must[transport.Changes](t, "changes through the share")(bob.GetChanges(ctx, ref, 0, "", 0))
	// A second invitation, declined.
	carolGrant := []transport.NewGrant{{PrincipalType: apiclient.NewGrantPrincipalTypeUser, PrincipalId: carolMe.Id, Permission: apiclient.SharePermissionViewer}}
	invite := must[transport.Share](t, "create share for carol")(ada.CreateShare(ctx, transport.CreateShare{VaultId: shared.Id, ResourceType: apiclient.ResourceTypeVault, DisplayName: "All", Grants: &carolGrant}))
	must[transport.Share](t, "decline share")(carol.DeclineShare(ctx, invite.Id.String()))
	// --- folder renames (§3.4.7, ADR-0040) ---
	// A move_prefix renames the shared folder in one go (one move revision per
	// file) and the share follows it, a case-only rename included; moving the
	// last file out of the shared folder one by one is SHARE_ROOT_MOVE, and so
	// is renaming the root from the mount.
	movePrefix := func(what, from, to string) syncproto.OpResult {
		res := must[syncproto.CommitResponse](t, what)(ada.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: dev.Id.String(), Ops: []syncproto.Op{
			{OpID: uuid.NewString(), Op: syncproto.OpMovePrefix, From: from, To: to},
		}}))
		return res.Results[0]
	}
	sharePrefix := func() string {
		s := must[transport.Share](t, "get share")(ada.GetShare(ctx, sid))
		if s.PathPrefix == nil {
			return ""
		}
		return *s.PathPrefix
	}
	before := must[transport.Changes](t, "changes before move_prefix")(ada.GetChanges(ctx, vid, 0, "", 500)).NextSeq
	if r := movePrefix("move_prefix", "Docs", "Papers"); r.Status != syncproto.StatusAccepted {
		t.Fatalf("move_prefix: %+v", r)
	}
	if p := sharePrefix(); p != "Papers" {
		t.Fatalf("share prefix after move_prefix: %q", p)
	}
	if r := movePrefix("case-only move_prefix", "Papers", "papers"); r.Status != syncproto.StatusAccepted {
		t.Fatalf("case-only move_prefix: %+v", r)
	}
	if p := sharePrefix(); p != "papers" {
		t.Fatalf("share prefix after the case-only rename: %q", p)
	}
	moves := must[transport.Changes](t, "changes after move_prefix")(ada.GetChanges(ctx, vid, before, "", 500))
	if len(moves.Items) != 4 {
		t.Fatalf("changes after two folder renames of two files: %+v", moves.Items)
	}
	for _, c := range moves.Items {
		if c.Op != "move" || c.PrevPath == "" || !strings.HasPrefix(c.Path, "Papers/") && !strings.HasPrefix(c.Path, "papers/") {
			t.Fatalf("folder rename change: %+v", c)
		}
	}
	if r := movePrefix("move_prefix of nothing", "Nowhere", "Elsewhere"); r.Status != syncproto.StatusRejected || r.Code != syncproto.CodeNotFound {
		t.Fatalf("move_prefix of an empty folder: %+v", r)
	}
	current := map[string]int{}
	for _, it := range must[transport.Tree](t, "tree after move_prefix")(ada.GetTree(ctx, vid)).Items {
		current[it.FileID] = it.Rev
	}
	bigRev, planRev := current[bigID], current[fileID]
	res = must[syncproto.CommitResponse](t, "moves out of the shared folder")(ada.Commit(ctx, vid, syncproto.CommitRequest{DeviceID: dev.Id.String(), Ops: []syncproto.Op{
		{OpID: uuid.NewString(), Op: syncproto.OpMove, FileID: bigID, BaseRev: &bigRev, Path: "big.bin"},
		{OpID: uuid.NewString(), Op: syncproto.OpMove, FileID: fileID, BaseRev: &planRev, Path: "plan.md"},
	}}))
	if res.Results[0].Status != syncproto.StatusAccepted || res.Results[1].Status != syncproto.StatusRejected || res.Results[1].Code != syncproto.CodeShareRootMove {
		t.Fatalf("moving the last file out of the shared folder: %+v", res.Results)
	}
	bobDev := must[transport.Device](t, "register bob")(bob.RegisterDevice(ctx, transport.DeviceRegistration{Name: "bob laptop", Platform: apiclient.Linux}))
	res = must[syncproto.CommitResponse](t, "move_prefix of the mount root")(bob.Commit(ctx, ref, syncproto.CommitRequest{DeviceID: bobDev.Id.String(), Ops: []syncproto.Op{
		{OpID: uuid.NewString(), Op: syncproto.OpMovePrefix, To: "Renamed"},
	}}))
	if res.Results[0].Status != syncproto.StatusRejected || res.Results[0].Code != syncproto.CodeShareRootMove {
		t.Fatalf("renaming the root from the mount: %+v", res.Results)
	}

	check(t, "revoke share", ada.RevokeShare(ctx, sid))
	_, err = bob.GetTree(ctx, ref)
	wantCode(t, "revoked share", err, syncproto.CodeNotFound)

	// --- coverage and verdict ---
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	for _, v := range recorder.violations {
		t.Error(v)
	}
	if recorder.outside == 0 {
		t.Error("the tus upload did not go through the validating transport")
	}
	var unexercised []string
	for _, item := range spec.Paths.InMatchingOrder() {
		for _, op := range spec.Paths.Value(item).Operations() {
			if slices.Contains(op.Tags, "admin") || slices.Contains(notUsedByTransport, op.OperationID) {
				continue
			}
			if recorder.seen[op.OperationID] == 0 {
				unexercised = append(unexercised, op.OperationID)
			}
		}
	}
	sort.Strings(unexercised)
	if len(unexercised) > 0 {
		t.Errorf("operations of the spec not exercised through the transport (exercise them or list them in notUsedByTransport): %v", unexercised)
	}
	t.Logf("validated %d operations, %d calls outside the contract (tus)", len(recorder.seen), recorder.outside)
}
