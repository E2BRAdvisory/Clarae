package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// tusChunk is the size of each PATCH; large enough for throughput, small
// enough that a lost connection costs little.
const tusChunk = 8 << 20

// TusUpload sends data with the resumable protocol (tus 1.0.0): it creates an
// upload, asks the server for the offset (so an interrupted run can resume
// when called again with the same upload URL) and sends the rest in chunks.
// progress, if set, is called with the bytes sent so far. resumeURL may be
// the Location returned by a previous attempt ("" to start a new upload).
// It returns the upload URL so callers can persist it for resumption.
func (c *Client) TusUpload(ctx context.Context, vault, hash string, data []byte, resumeURL string, progress func(sent int64)) (string, error) {
	loc := resumeURL
	offset := int64(0)
	if loc != "" {
		resp, err := c.raw(ctx, http.MethodHead, strings.TrimPrefix(loc, BasePath), nil, tusHeaders(nil))
		if err == nil && resp.StatusCode == http.StatusOK {
			offset, _ = strconv.ParseInt(resp.Header.Get("Upload-Offset"), 10, 64)
			_ = resp.Body.Close()
		} else {
			if err == nil {
				_ = resp.Body.Close()
			}
			loc = "" // gone or expired: start over
		}
	}
	if loc == "" {
		meta := "sha256 " + base64.StdEncoding.EncodeToString([]byte(hash))
		resp, err := c.raw(ctx, http.MethodPost, "/vaults/"+vault+"/uploads", nil, tusHeaders(map[string]string{
			"Upload-Length": strconv.Itoa(len(data)), "Upload-Metadata": meta,
		}))
		if err != nil {
			return "", err
		}
		if resp.StatusCode != http.StatusCreated {
			return "", decode(resp, nil)
		}
		_ = resp.Body.Close()
		loc = resp.Header.Get("Location")
		if loc == "" {
			return "", fmt.Errorf("tus: server returned no Location")
		}
		offset = 0
	}
	path := strings.TrimPrefix(loc, BasePath)
	for offset < int64(len(data)) {
		end := min(offset+tusChunk, int64(len(data)))
		resp, err := c.raw(ctx, http.MethodPatch, path, data[offset:end], tusHeaders(map[string]string{
			"Upload-Offset": strconv.FormatInt(offset, 10), "Content-Type": "application/offset+octet-stream",
		}))
		if err != nil {
			return loc, err
		}
		if resp.StatusCode != http.StatusNoContent {
			return loc, decode(resp, nil)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		offset = end
		if progress != nil {
			progress(offset)
		}
	}
	return loc, nil
}

func tusHeaders(h map[string]string) map[string]string {
	out := map[string]string{"Tus-Resumable": "1.0.0"}
	for k, v := range h {
		out[k] = v
	}
	return out
}

var _ = bytes.NewReader
