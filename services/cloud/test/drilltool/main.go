// Command drilltool is the data-plane helper of scripts/chaos/restore-drill.sh: a fake OIDC
// issuer, a client that creates and verifies vault data through the real API, a blob
// consistency check between the database and the object store, and S3 versioning probes.
// It is a test tool: it is never part of the released binary.
//
//	drilltool issuer  -addr 127.0.0.1:18999
//	drilltool seed    -api URL -issuer URL -manifest F -tag a -n 30
//	drilltool delete  -api URL -issuer URL -manifest F -tag b
//	drilltool verify  -api URL -issuer URL -manifest F -expect a,b -absent c [-stale-cursor N]
//	drilltool verify-blobs -db URL -s3 host:port -ak K -sk S -bucket B
//	drilltool s3 <probe|enable|lifecycle|rm|restore|overwrite|versions> ...
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

func main() {
	if len(os.Args) < 2 {
		fail("usage: drilltool <issuer|seed|delete|verify|verify-blobs|s3> ...")
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "issuer":
		issuer(args)
	case "seed":
		seed(args)
	case "delete":
		deleteTag(args)
	case "verify":
		verify(args)
	case "verify-blobs":
		verifyBlobs(args)
	case "s3":
		s3cmd(args)
	default:
		fail("unknown command " + cmd)
	}
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "FAIL: "+format+"\n", a...)
	os.Exit(1)
}

func check(err error) {
	if err != nil {
		fail("%v", err)
	}
}

// ---- fake OIDC issuer ------------------------------------------------------

func issuer(args []string) {
	fs := flag.NewFlagSet("issuer", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:18999", "listen address")
	_ = fs.Parse(args)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	check(err)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "drill"))
	check(err)
	base := "http://" + *addr
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": base, "jwks_uri": base + "/jwks", "authorization_endpoint": base + "/auth", "token_endpoint": base + "/token", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "drill", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/mint", func(w http.ResponseWriter, r *http.Request) {
		user := r.URL.Query().Get("user")
		now := time.Now()
		claims := jwt.Claims{Issuer: base, Subject: "drill-" + user, Audience: jwt.Audience{"nodus-api"}, IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)), Expiry: jwt.NewNumericDate(now.Add(time.Hour))}
		priv := map[string]any{"typ": "Bearer", "azp": "nodus-desktop", "preferred_username": user, "email": user + "@drill.local", "realm_access": map[string]any{"roles": []string{"nodus-user"}}}
		raw, err := jwt.Signed(signer).Claims(claims).Claims(priv).Serialize()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_, _ = io.WriteString(w, raw)
	})
	srv := httptest.NewUnstartedServer(mux)
	l, err := net.Listen("tcp", *addr)
	check(err)
	srv.Listener = l
	srv.Start()
	fmt.Println("issuer listening on", base)
	select {}
}

// ---- API client ------------------------------------------------------------

type api struct {
	base, issuer, token string
}

func newAPI(base, issuerURL, user string) *api {
	resp, err := http.Get(issuerURL + "/mint?user=" + user)
	check(err)
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return &api{base: strings.TrimRight(base, "/") + "/api/v1", issuer: issuerURL, token: string(b)}
}

func (a *api) do(method, path string, body any, headers map[string]string) (int, []byte) {
	var rd io.Reader
	switch v := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(v)
	default:
		b, _ := json.Marshal(v)
		rd = bytes.NewReader(b)
		if headers == nil {
			headers = map[string]string{}
		}
		headers["Content-Type"] = "application/json"
	}
	req, err := http.NewRequest(method, a.base+path, rd)
	check(err)
	req.Header.Set("Authorization", "Bearer "+a.token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: time.Minute}).Do(req)
	check(err)
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func (a *api) must(method, path string, body any, want int, out any) {
	st, b := a.do(method, path, body, nil)
	if st != want {
		fail("%s %s -> %d (want %d): %s", method, path, st, want, b)
	}
	if out != nil {
		check(json.Unmarshal(b, out))
	}
}

type fileRec struct {
	Tag     string `json:"tag"`
	Path    string `json:"path"`
	FileID  string `json:"file_id"`
	Hash    string `json:"hash"`
	Rev     int    `json:"rev"`
	Deleted bool   `json:"deleted"`
}

type manifest struct {
	Vault    string    `json:"vault"`
	DeviceID string    `json:"device_id"`
	LastSeq  int64     `json:"last_seq"`
	Files    []fileRec `json:"files"`
}

func loadManifest(path string) manifest {
	var m manifest
	if b, err := os.ReadFile(path); err == nil {
		check(json.Unmarshal(b, &m))
	}
	return m
}

func (m manifest) save(path string) {
	b, _ := json.MarshalIndent(m, "", "  ")
	check(os.WriteFile(path, b, 0o644))
}

func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// content is deterministic so verification can recompute it; every 10th file is large.
func content(tag string, i int) []byte {
	head := fmt.Sprintf("drill %s file %03d\n", tag, i)
	if i%10 == 0 {
		return []byte(head + strings.Repeat(fmt.Sprintf("%s-%03d-block\n", tag, i), 20000))
	}
	return []byte(head + strings.Repeat("x", i*7))
}

func commonFlags(fs *flag.FlagSet) (apiURL, issuerURL, mf *string) {
	return fs.String("api", "", "API base URL"), fs.String("issuer", "", "fake issuer URL"), fs.String("manifest", "manifest.json", "manifest file")
}

func seed(args []string) {
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	apiURL, issuerURL, mf := commonFlags(fs)
	tag := fs.String("tag", "a", "batch tag")
	n := fs.Int("n", 30, "files")
	_ = fs.Parse(args)
	a := newAPI(*apiURL, *issuerURL, "drill")
	m := loadManifest(*mf)
	a.must("GET", "/me", nil, 200, nil)
	if m.DeviceID == "" {
		var d map[string]any
		a.must("POST", "/me/devices", map[string]any{"name": "drill", "platform": "linux"}, 201, &d)
		m.DeviceID = d["id"].(string)
	}
	if m.Vault == "" {
		var v map[string]any
		a.must("POST", "/vaults", map[string]any{"name": "drill-" + uuid.NewString()[:8], "kind": "shared"}, 201, &v)
		m.Vault = v["id"].(string)
	}
	var ops []map[string]any
	var recs []fileRec
	for i := 0; i < *n; i++ {
		data := content(*tag, i)
		h := sha(data)
		st, b := a.do("PUT", "/vaults/"+m.Vault+"/blobs/"+h, data, map[string]string{"Content-Type": "application/octet-stream"})
		if st != 204 {
			fail("put blob: %d %s", st, b)
		}
		id := uuid.Must(uuid.NewV7()).String()
		p := fmt.Sprintf("drill/%s-%03d.md", *tag, i)
		ops = append(ops, map[string]any{"op_id": uuid.Must(uuid.NewV7()).String(), "op": "create", "file_id": id, "path": p, "blob_hash": h})
		recs = append(recs, fileRec{Tag: *tag, Path: p, FileID: id, Hash: h, Rev: 1})
	}
	for i := 0; i < len(ops); i += 50 {
		var out struct {
			Results []map[string]any `json:"results"`
			LastSeq int64            `json:"last_seq"`
		}
		a.must("POST", "/vaults/"+m.Vault+"/commit", map[string]any{"device_id": m.DeviceID, "ops": ops[i:min(i+50, len(ops))]}, 200, &out)
		for _, r := range out.Results {
			if r["status"] != "accepted" {
				fail("op not accepted: %v", r)
			}
		}
		m.LastSeq = out.LastSeq
	}
	m.Files = append(m.Files, recs...)
	m.save(*mf)
	fmt.Printf("seeded %d files (tag %s), last_seq=%d\n", *n, *tag, m.LastSeq)
}

func deleteTag(args []string) {
	fs := flag.NewFlagSet("delete", flag.ExitOnError)
	apiURL, issuerURL, mf := commonFlags(fs)
	tag := fs.String("tag", "b", "batch tag")
	_ = fs.Parse(args)
	a := newAPI(*apiURL, *issuerURL, "drill")
	m := loadManifest(*mf)
	var ops []map[string]any
	for i := range m.Files {
		if m.Files[i].Tag == *tag && !m.Files[i].Deleted {
			ops = append(ops, map[string]any{"op_id": uuid.Must(uuid.NewV7()).String(), "op": "delete", "file_id": m.Files[i].FileID, "base_rev": m.Files[i].Rev})
			m.Files[i].Deleted = true
		}
	}
	for i := 0; i < len(ops); i += 50 {
		var out struct {
			LastSeq int64 `json:"last_seq"`
		}
		a.must("POST", "/vaults/"+m.Vault+"/commit", map[string]any{"device_id": m.DeviceID, "ops": ops[i:min(i+50, len(ops))]}, 200, &out)
		m.LastSeq = out.LastSeq
	}
	m.save(*mf)
	fmt.Printf("deleted %d files of tag %s, last_seq=%d\n", len(ops), *tag, m.LastSeq)
}

func verify(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	apiURL, issuerURL, mf := commonFlags(fs)
	expect := fs.String("expect", "", "comma-separated tags that must be present and intact")
	absent := fs.String("absent", "", "comma-separated tags that must not be present")
	stale := fs.Int64("stale-cursor", 0, "a cursor beyond the server's last_seq: changes must answer CURSOR_EXPIRED")
	_ = fs.Parse(args)
	a := newAPI(*apiURL, *issuerURL, "drill")
	m := loadManifest(*mf)
	var tree struct {
		Items []struct {
			Path, FileID, Hash string
			Rev                int
		} `json:"items"`
		AsOfSeq int64 `json:"as_of_seq"`
	}
	a.must("GET", "/vaults/"+m.Vault+"/tree", nil, 200, &tree)
	byPath := map[string]string{}
	for _, it := range tree.Items {
		byPath[it.Path] = it.Hash
	}
	inTags := func(list, tag string) bool {
		for _, t := range strings.Split(list, ",") {
			if t == tag && t != "" {
				return true
			}
		}
		return false
	}
	want, blobs := 0, 0
	for _, f := range m.Files {
		switch {
		case inTags(*expect, f.Tag):
			want++
			if byPath[f.Path] != f.Hash {
				fail("file %s: missing or different in the restored vault", f.Path)
			}
			st, b := a.do("GET", "/vaults/"+m.Vault+"/blobs/"+f.Hash, nil, nil)
			if st != 200 || sha(b) != f.Hash {
				fail("blob of %s: status %d, digest ok=%v", f.Path, st, st == 200 && sha(b) == f.Hash)
			}
			blobs++
		case inTags(*absent, f.Tag):
			if _, ok := byPath[f.Path]; ok {
				fail("file %s (tag %s) must not exist after the restore", f.Path, f.Tag)
			}
		}
	}
	if len(tree.Items) != want {
		fail("tree has %d files, want %d", len(tree.Items), want)
	}
	// A full pull from 0: contiguous seq, no gaps.
	var ch struct {
		Items []struct {
			Seq int64
		} `json:"items"`
		NextSeq int64 `json:"next_seq"`
		HasMore bool  `json:"has_more"`
	}
	since, total := int64(0), 0
	for {
		a.must("GET", fmt.Sprintf("/vaults/%s/changes?since=%d&limit=500", m.Vault, since), nil, 200, &ch)
		for _, it := range ch.Items {
			total++
			if it.Seq != int64(total) {
				fail("changelog seq %d at position %d: gap after the restore", it.Seq, total)
			}
		}
		since = ch.NextSeq
		if !ch.HasMore {
			break
		}
	}
	if total != want {
		fail("changelog has %d entries, want %d", total, want)
	}
	if *stale > 0 {
		st, b := a.do("GET", fmt.Sprintf("/vaults/%s/changes?since=%d", m.Vault, *stale), nil, nil)
		if st != http.StatusGone || !bytes.Contains(b, []byte("CURSOR_EXPIRED")) {
			fail("a cursor ahead of the server must get 410 CURSOR_EXPIRED, got %d %s", st, b)
		}
		fmt.Println("stale cursor", *stale, "-> 410 CURSOR_EXPIRED (client will bootstrap)")
	}
	fmt.Printf("VERIFY OK: %d files, %d blobs downloaded and hashed, changelog 1..%d contiguous, as_of_seq=%d\n", want, blobs, total, tree.AsOfSeq)
}

// ---- database <-> object store ---------------------------------------------

func s3client(endpoint, ak, sk string) *minio.Client {
	c, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(ak, sk, ""), Secure: false, BucketLookup: minio.BucketLookupPath, Region: "us-east-1"})
	check(err)
	return c
}

func verifyBlobs(args []string) {
	fs := flag.NewFlagSet("verify-blobs", flag.ExitOnError)
	dbURL := fs.String("db", "", "database URL")
	ep := fs.String("s3", "", "S3 host:port")
	ak := fs.String("ak", "", "access key")
	sk := fs.String("sk", "", "secret key")
	bucket := fs.String("bucket", "nodus-blobs", "bucket")
	_ = fs.Parse(args)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, *dbURL)
	check(err)
	rows, err := conn.Query(ctx, `SELECT hash, size, storage_key FROM blobs WHERE ref_count > 0`)
	check(err)
	c := s3client(*ep, *ak, *sk)
	checked, missing, wrong := 0, 0, 0
	for rows.Next() {
		var hash, key string
		var size int64
		check(rows.Scan(&hash, &size, &key))
		checked++
		st, err := c.StatObject(ctx, *bucket, key, minio.StatObjectOptions{})
		switch {
		case err != nil:
			missing++
			fmt.Printf("MISSING %s (%v)\n", key, err)
		case st.Size != size:
			wrong++
			fmt.Printf("SIZE MISMATCH %s: store %d, db %d\n", key, st.Size, size)
		}
	}
	check(rows.Err())
	_ = conn.Close(ctx)
	fmt.Printf("blobs checked=%d missing=%d size-mismatch=%d\n", checked, missing, wrong)
	if missing+wrong > 0 {
		os.Exit(2)
	}
}

// ---- S3 versioning ---------------------------------------------------------

func s3cmd(args []string) {
	if len(args) < 1 {
		fail("s3 <probe|enable|lifecycle|rm|restore|overwrite|versions>")
	}
	sub := args[0]
	fs := flag.NewFlagSet("s3", flag.ExitOnError)
	ep := fs.String("s3", "", "S3 host:port")
	ak := fs.String("ak", "", "access key")
	sk := fs.String("sk", "", "secret key")
	bucket := fs.String("bucket", "nodus-blobs", "bucket")
	key := fs.String("key", "", "object key")
	_ = fs.Parse(args[1:])
	ctx := context.Background()
	c := s3client(*ep, *ak, *sk)
	switch sub {
	case "mkbucket":
		if ok, err := c.BucketExists(ctx, *bucket); err != nil || !ok {
			check(c.MakeBucket(ctx, *bucket, minio.MakeBucketOptions{Region: "us-east-1"}))
		}
	case "enable":
		check(c.EnableVersioning(ctx, *bucket))
		v, err := c.GetBucketVersioning(ctx, *bucket)
		check(err)
		if v.Status != "Enabled" {
			fail("versioning status after enable: %q", v.Status)
		}
		fmt.Println("versioning enabled on", *bucket)
	case "lifecycle":
		cfg := lifecycle.NewConfiguration()
		cfg.Rules = []lifecycle.Rule{{ID: "expire-noncurrent-30d", Status: "Enabled", NoncurrentVersionExpiration: lifecycle.NoncurrentVersionExpiration{NoncurrentDays: 30}}}
		check(c.SetBucketLifecycle(ctx, *bucket, cfg))
		got, err := c.GetBucketLifecycle(ctx, *bucket)
		check(err)
		fmt.Printf("lifecycle rules stored: %d\n", len(got.Rules))
	case "versions":
		listVersions(ctx, c, *bucket, *key)
	case "rm": // creates a delete marker on a versioned bucket
		check(c.RemoveObject(ctx, *bucket, *key, minio.RemoveObjectOptions{}))
		fmt.Println("removed", *key)
	case "overwrite": // a bad writer replaces the object with garbage
		_, err := c.PutObject(ctx, *bucket, *key, strings.NewReader("CORRUPTED"), 9, minio.PutObjectOptions{})
		check(err)
		fmt.Println("overwrote", *key)
	case "restore":
		restore(ctx, c, *bucket, *key)
	case "probe":
		probe(ctx, c, *bucket)
	}
}

func listVersions(ctx context.Context, c *minio.Client, bucket, key string) []minio.ObjectInfo {
	var out []minio.ObjectInfo
	for o := range c.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: key, WithVersions: true, Recursive: true}) {
		check(o.Err)
		out = append(out, o)
		fmt.Printf("  version=%s latest=%v deleteMarker=%v size=%d\n", o.VersionID, o.IsLatest, o.IsDeleteMarker, o.Size)
	}
	return out
}

// restore brings the object back to its last good state: it removes a delete marker, or removes
// the newest version when it is the bad overwrite (the previous version becomes current).
func restore(ctx context.Context, c *minio.Client, bucket, key string) {
	vs := listVersions(ctx, c, bucket, key)
	if len(vs) == 0 {
		fail("no versions of %s", key)
	}
	latest := vs[0]
	for _, v := range vs {
		if v.IsLatest {
			latest = v
		}
	}
	if latest.IsDeleteMarker {
		check(c.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{VersionID: latest.VersionID}))
		fmt.Println("removed the delete marker: object visible again")
		return
	}
	if len(vs) < 2 {
		fail("only one version: nothing to roll back to")
	}
	check(c.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{VersionID: latest.VersionID}))
	fmt.Println("removed the overwriting version: the previous one is current again")
}

// probe reports whether the store really supports versioning (put twice, delete, list versions).
func probe(ctx context.Context, c *minio.Client, bucket string) {
	if err := c.EnableVersioning(ctx, bucket); err != nil {
		fmt.Println("PROBE versioning=UNSUPPORTED enable:", err)
		return
	}
	v, err := c.GetBucketVersioning(ctx, bucket)
	if err != nil || v.Status != "Enabled" {
		fmt.Println("PROBE versioning=UNSUPPORTED status:", v.Status, err)
		return
	}
	k := "probe/" + uuid.NewString()
	for _, body := range []string{"one", "two"} {
		if _, err := c.PutObject(ctx, bucket, k, strings.NewReader(body), int64(len(body)), minio.PutObjectOptions{}); err != nil {
			fmt.Println("PROBE versioning=UNSUPPORTED put:", err)
			return
		}
	}
	_ = c.RemoveObject(ctx, bucket, k, minio.RemoveObjectOptions{})
	n, markers := 0, 0
	for o := range c.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: k, WithVersions: true, Recursive: true}) {
		if o.Err != nil {
			fmt.Println("PROBE versioning=UNSUPPORTED list:", o.Err)
			return
		}
		n++
		if o.IsDeleteMarker {
			markers++
		}
	}
	if n == 3 && markers == 1 {
		fmt.Println("PROBE versioning=SUPPORTED (2 versions + 1 delete marker listed)")
		return
	}
	fmt.Printf("PROBE versioning=PARTIAL versions listed=%d markers=%d (expected 3 and 1)\n", n, markers)
}
