package app

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckStandaloneHTML(t *testing.T) {
	ok := []string{
		`<!doctype html><html><head><meta charset="utf-8"><style>body{color:red}</style></head><body><p>hi</p></body></html>`,
		`<p>quoting &lt;script&gt;alert(1)&lt;/script&gt; and src="http://x" in text</p>`,
		`<p>x <a href="https://example.com/a">link</a> <a href="#sec">in page</a></p>`,
		`<img src="data:image/png;base64,AAAA" alt="x">`,
		`<pre><code>a one = 1; onload = 2</code></pre>`,
	}
	for _, h := range ok {
		if err := checkStandaloneHTML(h); err != nil {
			t.Errorf("rejected %q: %v", h, err)
		}
	}
	bad := []string{
		`<script>alert(1)</script>`,
		`<SCRIPT src=x></SCRIPT>`,
		`<p onclick="x()">a</p>`,
		`<img src="https://evil.example/p.png">`,
		`<img src='//evil.example/p.png'>`,
		`<iframe src="about:blank"></iframe>`,
		`<link rel="stylesheet" href="https://x/y.css">`,
		`<style>@import url(https://x/y.css);</style>`,
		`<style>body{background:url(http://x/y.png)}</style>`,
		`<a href="javascript:alert(1)">x</a>`,
		`<meta http-equiv="refresh" content="0;url=http://x">`,
	}
	for _, h := range bad {
		if err := checkStandaloneHTML(h); err == nil {
			t.Errorf("accepted %q", h)
		}
	}
}

func TestHTMLExportFilename(t *testing.T) {
	now := time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC)
	if got := htmlExportFilename("My Note: v2/final", now); got != "My_Note_v2final-20260304.html" {
		t.Errorf("got %q", got)
	}
	if got := htmlExportFilename("///", now); got != "note-20260304.html" {
		t.Errorf("got %q", got)
	}
}

func TestWriteExportHTML(t *testing.T) {
	root := t.TempDir()
	out := t.TempDir()
	res, err := writeExportHTML(root, filepath.Join(out, "note"), "<p>hi</p>")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(res.Path) != "note.html" || res.Files != 1 || res.Bytes != 9 {
		t.Errorf("result %+v", res)
	}
	b, err := os.ReadFile(res.Path)
	if err != nil || string(b) != "<p>hi</p>" {
		t.Fatalf("content %q err %v", b, err)
	}
	entries, _ := os.ReadDir(out)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".part") {
			t.Errorf("temporary file left behind: %s", e.Name())
		}
	}
	// Inside the vault: refused, and nothing is written.
	if _, err := writeExportHTML(root, filepath.Join(root, "sub.html"), "x"); err == nil {
		t.Error("destination inside the vault was accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "sub.html")); err == nil {
		t.Error("file written into the vault")
	}
}

func TestDecodeExportValidatesContent(t *testing.T) {
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nrest"))
	svg := func(body string) string { return base64.StdEncoding.EncodeToString([]byte(body)) }
	cases := []struct {
		name, mime, data string
		ok               bool
	}{
		{"png", "image/png", png, true},
		{"png with wrong magic", "image/png", svg("GIF89a"), false},
		{"svg", "image/svg+xml", svg(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`), true},
		{"svg with script", "image/svg+xml", svg(`<svg><script>alert(1)</script></svg>`), false},
		{"svg with handler", "image/svg+xml", svg(`<svg><rect onload="x()"/></svg>`), false},
		{"svg with remote image", "image/svg+xml", svg(`<svg><image href="x" xlink:href="https://evil/x.png"/></svg>`), false},
		{"not svg", "image/svg+xml", svg(`<html></html>`), false},
		{"pdf", "application/pdf", svg("%PDF-1.7\n"), true},
		{"not pdf", "application/pdf", svg("hello"), false},
		{"json", "application/json", svg(`{"type":"excalidraw","elements":[]}`), true},
		{"bad json", "application/json", svg(`{`), false},
		{"empty", "image/png", "", false},
		{"not base64", "image/png", "!!!", false},
	}
	for _, c := range cases {
		_, err := decodeExport(exportFormats[c.mime].check, c.data)
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestSafeExportName(t *testing.T) {
	now := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	if got := safeExportName("My drawing/é", ".png", "export", now); got != "My_drawingé-20261027.png" {
		t.Errorf("got %q", got)
	}
	if got := safeExportName("///", ".svg", "export", now); got != "export-20261027.svg" {
		t.Errorf("got %q", got)
	}
}
