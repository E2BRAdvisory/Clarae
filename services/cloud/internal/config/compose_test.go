package config

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

const composeFile = "../../../../deploy/compose/compose.yaml"

func readCompose(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(composeFile)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The settings that fix the identity of an installation (volumes, database, realm) must have no
// default in the Compose file: a default of the new name would start an installation made before
// 2.0 on empty volumes and a second realm (ADR-0052, M17 B4). The names the binary derives from the
// realm must pass through empty, so that the binary decides; the variables renamed by the rebrand
// keep their 1.x name as a fallback.
func TestComposeKeepsTheIdentityOfAnInstallationExplicit(t *testing.T) {
	c := readCompose(t)
	for _, want := range []string{
		"name: ${COMPOSE_PROJECT_NAME:?",
		"POSTGRES_USER: ${POSTGRES_USER:?",
		"POSTGRES_DB: ${POSTGRES_DB:?",
		"/realms/${KC_REALM:?",
		"KC_REALM: ${KC_REALM}",
		"postgres://${POSTGRES_USER:?",
		"@postgres:5432/${POSTGRES_DB:?",
		// the binary decides from the realm: empty here
		"S3_BUCKET_BLOBS: ${S3_BUCKET_BLOBS:-}",
		"S3_BUCKET_EXPORTS: ${S3_BUCKET_EXPORTS:-}",
		"OIDC_AUDIENCE: ${OIDC_AUDIENCE:-}",
		"OIDC_ALLOWED_AZP: ${OIDC_ALLOWED_AZP:-}",
		"OIDC_DESKTOP_CLIENT_ID: ${OIDC_DESKTOP_CLIENT_ID:-}",
		"OIDC_WEB_CLIENT_ID: ${OIDC_WEB_CLIENT_ID:-}",
		"KC_ADMIN_CLIENT_ID: ${KC_ADMIN_CLIENT_ID:-}",
		// the variables of 1.x still work
		"${CLARAE_HOST:-${MEMOBRAIN_HOST:?",
		"${CLARAE_SITE:-${MEMOBRAIN_SITE:-${CLARAE_HOST:-${MEMOBRAIN_HOST}}}}",
		"${CLARAE_VERSION:-${MEMOBRAIN_VERSION:?",
		"${CLARAE_IMAGE:-${MEMOBRAIN_IMAGE:-ghcr.io/e2br/clarae-cloud}}",
		"${CLARAE_ALLOW_PLACEHOLDER_SECRETS:-${MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS:-}}",
	} {
		if !strings.Contains(c, want) {
			t.Errorf("compose.yaml does not contain %q", want)
		}
	}
	// No hard-coded name of the product left in the identity of the stack.
	for _, bad := range []string{"POSTGRES_USER: clarae", "POSTGRES_DB: clarae", "KC_REALM: clarae", "S3_BUCKET_BLOBS: clarae-blobs", "-U clarae"} {
		if strings.Contains(c, bad) {
			t.Errorf("compose.yaml still hard-codes %q", bad)
		}
	}
}

// s3Script returns the shell script of the s3-init service, with the compose escaping ($$) undone.
func s3Script(t *testing.T) string {
	t.Helper()
	c := readCompose(t)
	start := strings.Index(c, "        fam=clarae\n")
	endMarker := "        echo buckets ready\n"
	end := strings.Index(c, endMarker)
	if start < 0 || end < start {
		t.Fatal("the script of s3-init was not found in compose.yaml")
	}
	var lines []string
	for _, l := range strings.Split(c[start:end+len(endMarker)], "\n") {
		lines = append(lines, strings.TrimPrefix(l, "        "))
	}
	return strings.ReplaceAll(strings.Join(lines, "\n"), "$$", "$")
}

// The s3-init service creates the buckets the cloud will use, by the same rule as the binary, and
// must not create a new empty bucket next to the one of a 1.x installation: the cloud refuses to
// start in that case, and a bucket created here would defeat that check.
func TestComposeS3InitFollowsTheRealmAndProtectsTheBucketsOf1x(t *testing.T) {
	script := s3Script(t)
	dir := t.TempDir()
	fakeAWS := `#!/bin/sh
# buckets that exist: $EXISTING (space separated); creations are appended to $CREATED
args="$*"
case "$args" in
  *head-bucket*) b="${args##*--bucket }"; for e in $EXISTING; do [ "$e" = "$b" ] && exit 0; done; exit 1 ;;
  *" mb "*) echo "${args##*s3://}" >> "$CREATED"; exit 0 ;;
esac
exit 2
`
	if err := os.WriteFile(filepath.Join(dir, "aws"), []byte(fakeAWS), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name     string
		env      []string
		existing string
		exit     int
		created  []string
		stderr   string
	}{
		{"new installation", []string{"KC_REALM=clarae"}, "", 0, []string{"clarae-blobs", "clarae-exports"}, ""},
		{"fresh realm of 1.x", []string{"KC_REALM=memobrain"}, "", 0, []string{"memobrain-blobs", "memobrain-exports"}, ""},
		{"1.x installation", []string{"KC_REALM=memobrain"}, "memobrain-blobs memobrain-exports", 0, nil, ""},
		{"new realm over the buckets of 1.x refuses", []string{"KC_REALM=clarae"}, "memobrain-blobs memobrain-exports", 1, nil, "S3_BUCKET_BLOBS=memobrain-blobs"},
		{"explicit old buckets", []string{"KC_REALM=clarae", "S3_BUCKET_BLOBS=memobrain-blobs", "S3_BUCKET_EXPORTS=memobrain-exports"}, "memobrain-blobs memobrain-exports", 0, nil, ""},
		{"explicit new names are the operator's decision", []string{"KC_REALM=clarae", "S3_BUCKET_BLOBS=clarae-blobs", "S3_BUCKET_EXPORTS=clarae-exports"}, "memobrain-blobs", 0, []string{"clarae-blobs", "clarae-exports"}, ""},
		{"new buckets already there", []string{"KC_REALM=clarae"}, "clarae-blobs clarae-exports memobrain-blobs", 0, nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := filepath.Join(t.TempDir(), "created")
			if err := os.WriteFile(log, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("/bin/sh", "-c", script) //nolint:gosec // the script of our own compose file
			cmd.Env = append([]string{"PATH=" + dir + ":/usr/bin:/bin", "EXISTING=" + tc.existing, "CREATED=" + log}, tc.env...)
			out, err := cmd.CombinedOutput()
			code := 0
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else if err != nil {
				t.Fatal(err)
			}
			b, _ := os.ReadFile(log)
			created := strings.Fields(string(b))
			if code != tc.exit || !slices.Equal(created, tc.created) {
				t.Fatalf("exit %d, created %v; want exit %d, created %v\n%s", code, created, tc.exit, tc.created, out)
			}
			if tc.stderr != "" && !strings.Contains(string(out), tc.stderr) {
				t.Fatalf("the message does not say how to fix it (%q):\n%s", tc.stderr, out)
			}
		})
	}
}

// .env.example lists every variable the file above requires, with the values of a new installation.
func TestEnvExampleSetsTheIdentityOfANewInstallation(t *testing.T) {
	b, err := os.ReadFile("../../../../deploy/compose/.env.example")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"COMPOSE_PROJECT_NAME", "POSTGRES_USER", "POSTGRES_DB", "KC_REALM"} {
		if !regexp.MustCompile(`(?m)^` + name + `=\S+`).Match(b) {
			t.Errorf(".env.example does not set %s", name)
		}
	}
}
