package syncproto

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

const hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

func rev(n int) *int { return &n }

func TestOpValidate(t *testing.T) {
	tests := []struct {
		name   string
		op     Op
		opaque bool
		wantOK bool
	}{
		{"create ok", Op{OpID: "1", Op: OpCreate, FileID: "f", Path: "a.md", BlobHash: hash, Size: 3}, false, true},
		{"create missing file_id", Op{OpID: "1", Op: OpCreate, Path: "a.md", BlobHash: hash}, false, false},
		{"create bad path", Op{OpID: "1", Op: OpCreate, FileID: "f", Path: "../a.md", BlobHash: hash}, false, false},
		{"create with base_rev", Op{OpID: "1", Op: OpCreate, FileID: "f", Path: "a.md", BlobHash: hash, BaseRev: rev(1)}, false, false},
		{"create bad hash", Op{OpID: "1", Op: OpCreate, FileID: "f", Path: "a.md", BlobHash: "xyz"}, false, false},
		{"create opaque ok", Op{OpID: "1", Op: OpCreate, FileID: "f", Path: "enc1:AbC-_123", BlobHash: hash}, true, true},
		{"create opaque v2 ok", Op{OpID: "1", Op: OpCreate, FileID: "f", Path: "enc2:AbC-_123", BlobHash: hash}, true, true},
		{"create opaque with clear path", Op{OpID: "1", Op: OpCreate, FileID: "f", Path: "a.md", BlobHash: hash}, true, false},
		{"modify ok", Op{OpID: "1", Op: OpModify, FileID: "f", BaseRev: rev(3), BlobHash: hash}, false, true},
		{"modify missing base_rev", Op{OpID: "1", Op: OpModify, FileID: "f", BlobHash: hash}, false, false},
		{"modify negative size", Op{OpID: "1", Op: OpModify, FileID: "f", BaseRev: rev(3), BlobHash: hash, Size: -1}, false, false},
		{"move ok", Op{OpID: "1", Op: OpMove, FileID: "f", BaseRev: rev(3), Path: "b/a.md"}, false, true},
		{"move missing path", Op{OpID: "1", Op: OpMove, FileID: "f", BaseRev: rev(3)}, false, false},
		{"delete ok", Op{OpID: "1", Op: OpDelete, FileID: "f", BaseRev: rev(3)}, false, true},
		{"restore ok", Op{OpID: "1", Op: OpRestore, FileID: "f", BaseRev: rev(3)}, false, true},
		{"move_prefix ok", Op{OpID: "1", Op: OpMovePrefix, From: "Progetti/Alfa", To: "Archivio/Alfa"}, false, true},
		{"move_prefix same", Op{OpID: "1", Op: OpMovePrefix, From: "A", To: "A"}, false, false},
		{"move_prefix nested", Op{OpID: "1", Op: OpMovePrefix, From: "A", To: "A/B"}, false, false},
		{"move_prefix private", Op{OpID: "1", Op: OpMovePrefix, From: "A", To: "B"}, true, false},
		{"unknown op", Op{OpID: "1", Op: "rename"}, false, false},
		{"missing op_id", Op{Op: OpDelete, FileID: "f", BaseRev: rev(1)}, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.op.Validate(tt.opaque)
			if tt.wantOK && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tt.wantOK {
				if err == nil {
					t.Fatal("expected error")
				}
				if !errors.Is(err, ErrInvalidOp) {
					t.Fatalf("error does not wrap ErrInvalidOp: %v", err)
				}
			}
		})
	}
}

func TestIsOpaquePath(t *testing.T) {
	if !IsOpaquePath("enc1:abcDEF012-_") || !IsOpaquePath("enc2:abcDEF012-_") {
		t.Error("valid token rejected")
	}
	for _, bad := range []string{"", "enc1:", "enc2:", "enc3:abc", "ENC2:abc", "abc", "enc1:ab+c", "enc2:ab/c", "enc1:" + strings.Repeat("a", MaxOpaquePathLen), "enc2:" + strings.Repeat("a", MaxOpaquePathLen)} {
		if IsOpaquePath(bad) {
			t.Errorf("IsOpaquePath(%q) should be false", bad)
		}
	}
}

func TestKindOf(t *testing.T) {
	tests := map[string]FileKind{
		"a.md":                       KindMarkdown,
		"Notes/A.MD":                 KindMarkdown,
		"Talks/Deck.marp":            KindMarkdown,
		"map.canvas":                 KindCanvas,
		"db.base":                    KindBase,
		"d.excalidraw":               KindExcalidraw,
		"img/x.png":                  KindAttachment,
		"doc.pdf":                    KindAttachment,
		"rec.m4a":                    KindAttachment,
		".clarae/editor.json":        KindConfig,
		".clarae/templates/daily.md": KindConfig,
		"README":                     KindOther,
		"data.csv":                   KindOther,
	}
	for p, want := range tests {
		if got := KindOf(p); got != want {
			t.Errorf("KindOf(%q) = %s want %s", p, got, want)
		}
	}
}

func TestHTTPStatus(t *testing.T) {
	tests := map[Code]int{
		CodeUnauthenticated:    http.StatusUnauthorized,
		CodeForbidden:          http.StatusForbidden,
		CodeUserSuspended:      http.StatusForbidden,
		CodeNotFound:           http.StatusNotFound,
		CodeValidationFailed:   http.StatusBadRequest,
		CodePathInvalid:        http.StatusBadRequest,
		CodeQuotaExceeded:      http.StatusRequestEntityTooLarge,
		CodeFileTooLarge:       http.StatusRequestEntityTooLarge,
		CodeRevConflict:        http.StatusConflict,
		CodePathCollision:      http.StatusConflict,
		CodeShareRootMove:      http.StatusConflict,
		CodeVaultEncrypted:     http.StatusConflict,
		CodeVaultKindImmutable: http.StatusConflict,
		CodeBlobMissing:        http.StatusUnprocessableEntity,
		CodeRateLimited:        http.StatusTooManyRequests,
		CodeCursorExpired:      http.StatusGone,
		CodeNameInUse:          http.StatusConflict,
		CodeInternal:           http.StatusInternalServerError,
		Code("whatever"):       http.StatusInternalServerError,
	}
	for c, want := range tests {
		if got := c.HTTPStatus(); got != want {
			t.Errorf("%s: got %d want %d", c, got, want)
		}
	}
}
