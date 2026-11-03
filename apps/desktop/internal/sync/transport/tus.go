package transport

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// tusChunk is the size of each PATCH; large enough for throughput, small
// enough that a lost connection costs little.
const tusChunk = 8 << 20

// tusResyncs bounds how many times in a row a PATCH refused for its offset
// is resumed from the offset the server reports, without progress in between.
const tusResyncs = 3

// TusUpload sends data with the resumable protocol (tus 1.0.0, outside the
// OpenAPI contract, hence built by hand on the same request pipeline): it creates an
// upload, asks the server for the offset (so an interrupted run can resume
// when called again with the same upload URL) and sends the rest in chunks.
// progress, if set, is called with the bytes sent so far. resumeURL may be
// the Location returned by a previous attempt ("" to start a new upload).
// It returns the upload URL so callers can persist it for resumption.
func (c *Client) TusUpload(ctx context.Context, ref, hash string, data []byte, resumeURL string, progress func(sent int64)) (string, error) {
	vault, scope := splitRef(ref)
	loc := resumeURL
	offset := int64(0)
	if loc != "" {
		var err error
		if offset, err = c.tusOffset(ctx, strings.TrimPrefix(loc, BasePath)); err != nil || offset > int64(len(data)) {
			loc, offset = "", 0 // gone or expired: start over
		}
	}
	if loc == "" {
		meta := "sha256 " + base64.StdEncoding.EncodeToString([]byte(hash))
		path := "/vaults/" + url.PathEscape(vault) + "/uploads"
		if scope != "" {
			path += "?" + url.Values{"scope": {scope}}.Encode()
		}
		resp, err := c.raw(ctx, http.MethodPost, path, nil, tusHeaders(map[string]string{
			"Upload-Length": strconv.Itoa(len(data)), "Upload-Metadata": meta,
		}))
		if err != nil {
			return "", err
		}
		if resp.StatusCode != http.StatusCreated {
			return "", decodeProblem(resp)
		}
		_ = resp.Body.Close()
		loc = resp.Header.Get("Location")
		if loc == "" {
			return "", fmt.Errorf("tus: server returned no Location")
		}
		offset = 0
	}
	path := strings.TrimPrefix(loc, BasePath)
	resyncs := 0
	for offset < int64(len(data)) {
		end := min(offset+tusChunk, int64(len(data)))
		resp, err := c.raw(transfer(ctx), http.MethodPatch, path, data[offset:end], tusHeaders(map[string]string{
			"Upload-Offset": strconv.FormatInt(offset, 10), "Content-Type": "application/offset+octet-stream",
		}))
		if err != nil {
			return loc, err
		}
		if resp.StatusCode != http.StatusNoContent {
			if !offsetMismatch(resp) || resyncs >= tusResyncs {
				return loc, decodeProblem(resp)
			}
			// The server holds more (or less) than this PATCH assumed: an attempt
			// that stalled after the server had stored its bytes, sent again by
			// the retry with the same Upload-Offset. Go on from the server's offset.
			discard(resp)
			server, err := c.tusOffset(ctx, path)
			if err != nil {
				return loc, err
			}
			if server > int64(len(data)) {
				return loc, fmt.Errorf("tus: the server holds %d bytes of a %d-byte upload", server, len(data))
			}
			resyncs++
			offset = server
			if progress != nil {
				progress(offset)
			}
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		resyncs = 0
		offset = end
		if progress != nil {
			progress(offset)
		}
	}
	return loc, nil
}

// tusOffset asks the server how many bytes of an upload it holds (HEAD). The
// server answers only once a complete upload is published, so an offset equal
// to the length means the blob exists.
func (c *Client) tusOffset(ctx context.Context, path string) (int64, error) {
	resp, err := c.raw(ctx, http.MethodHead, path, nil, tusHeaders(nil))
	if err != nil {
		return 0, err
	}
	if resp.StatusCode != http.StatusOK {
		return 0, decodeProblem(resp)
	}
	discard(resp)
	offset, err := strconv.ParseInt(resp.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || offset < 0 {
		return 0, fmt.Errorf("tus: invalid Upload-Offset %q", resp.Header.Get("Upload-Offset"))
	}
	return offset, nil
}

// offsetMismatch recognises a PATCH refused because its Upload-Offset is not
// the server's: 409 in tus 1.0.0; the MemoBrain cloud answers 400
// VALIDATION_FAILED with its own Upload-Offset.
func offsetMismatch(resp *http.Response) bool {
	return resp.StatusCode == http.StatusConflict ||
		(resp.StatusCode == http.StatusBadRequest && resp.Header.Get("Upload-Offset") != "")
}

func tusHeaders(h map[string]string) map[string]string {
	out := map[string]string{"Tus-Resumable": "1.0.0"}
	for k, v := range h {
		out[k] = v
	}
	return out
}
